import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  courses,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  users,
  videoWatchEvents,
  LessonProgressStatus,
  RefundStatus,
} from "~/db/schema";
import { formatPrice } from "~/lib/utils";

const REFUND_WINDOW_DAYS = 14;
const REFUND_COMPLETION_LIMIT = 0.5;
const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;

export type RefundRefusal =
  | "no-purchase"
  | "refunded"
  | "pending-request"
  | "claimed-seat"
  | "window-closed"
  | "completion-limit"
  | "watch-limit";

export type RefundEligibility =
  | {
      eligible: true;
      purchase: typeof purchases.$inferSelect;
      refundAmount: number;
      lastDayInWindow: string;
    }
  | { eligible: false; reason: RefundRefusal };

// The Refund Window counts whole days, not hours: a purchase at 23:00 still
// gets its full last day.
function calendarDay(when: Date) {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function hasRefundRequest(purchaseId: number, status: RefundStatus) {
  const row = db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, status)
      )
    )
    .get();
  return row !== undefined;
}

// A Claimed Seat belongs to the team, so the buyer cannot give it back.
function hasClaimedSeat(purchaseId: number) {
  const row = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();
  return row !== undefined;
}

function getLessonIds(courseId: number) {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();
  return result?.count ?? 0;
}

// Rewatching a stretch of a lesson does not count twice: only the furthest
// point reached in each lesson adds to the total.
function getSecondsWatched(userId: number, lessonIds: number[]) {
  return db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

export function getRefundEligibility(
  userId: number,
  courseId: number,
  now: Date
): RefundEligibility {
  const purchase = getLatestPurchase(userId, courseId);
  if (!purchase) return { eligible: false, reason: "no-purchase" };

  if (hasRefundRequest(purchase.id, RefundStatus.Approved)) {
    return { eligible: false, reason: "refunded" };
  }

  if (hasRefundRequest(purchase.id, RefundStatus.Pending)) {
    return { eligible: false, reason: "pending-request" };
  }

  if (hasClaimedSeat(purchase.id)) {
    return { eligible: false, reason: "claimed-seat" };
  }

  const windowEnd = new Date(purchase.createdAt);
  windowEnd.setDate(windowEnd.getDate() + REFUND_WINDOW_DAYS);
  const lastDayInWindow = calendarDay(windowEnd);
  if (calendarDay(now) > lastDayInWindow) {
    return { eligible: false, reason: "window-closed" };
  }

  const lessonIds = getLessonIds(courseId);
  if (lessonIds.length > 0) {
    const completed = getCompletedLessonCount(userId, lessonIds);
    if (completed / lessonIds.length >= REFUND_COMPLETION_LIMIT) {
      return { eligible: false, reason: "completion-limit" };
    }
    if (getSecondsWatched(userId, lessonIds) >= REFUND_WATCH_LIMIT_SECONDS) {
      return { eligible: false, reason: "watch-limit" };
    }
  }

  return {
    eligible: true,
    purchase,
    refundAmount: purchase.amountPaid,
    lastDayInWindow,
  };
}

export type RefundRequestEmail = { to: string; subject: string; body: string };

export type CreateRefundRequestResult =
  | { ok: true; email: RefundRequestEmail }
  | { ok: false; reason: RefundRefusal };

function buildRefundRequestEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  refundAmount: number;
}): RefundRequestEmail {
  return {
    to: input.learnerEmail,
    subject: `Refund requested — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have your refund request for "${input.courseTitle}".`,
      `If we approve it, we will refund ${formatPrice(input.refundAmount)}, the amount you paid.`,
      "",
      "Our team reviews every refund request by hand. You do not need to do anything else — we will email you again when it is done.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

// The caller sends the email.
export function createRefundRequest(input: {
  userId: number;
  courseId: number;
  reason: string;
  now: Date;
}): CreateRefundRequestResult {
  const eligibility = getRefundEligibility(input.userId, input.courseId, input.now);
  if (!eligibility.eligible) return { ok: false, reason: eligibility.reason };

  const learner = db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, input.userId))
    .get();
  const course = db
    .select({ title: courses.title })
    .from(courses)
    .where(eq(courses.id, input.courseId))
    .get();
  if (!learner || !course) {
    throw new Error(
      `Refund Request for missing learner ${input.userId} or course ${input.courseId}`
    );
  }

  db.insert(refunds)
    .values({
      purchaseId: eligibility.purchase.id,
      status: RefundStatus.Pending,
      reason: input.reason,
      requestedAt: input.now.toISOString(),
    })
    .run();

  return {
    ok: true,
    email: buildRefundRequestEmail({
      learnerName: learner.name,
      learnerEmail: learner.email,
      courseTitle: course.title,
      refundAmount: eligibility.refundAmount,
    }),
  };
}

export function getPendingRefundRequests(userId: number) {
  return db
    .select({
      id: refunds.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      amountPaid: purchases.amountPaid,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(eq(purchases.userId, userId), eq(refunds.status, RefundStatus.Pending))
    )
    .all();
}
