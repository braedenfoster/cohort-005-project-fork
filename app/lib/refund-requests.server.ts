import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  courses,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refundRequests,
  users,
  videoWatchEvents,
  LessonProgressStatus,
  RefundRequestStatus,
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

function getLatestPurchase(learnerId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, learnerId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function hasRefundRequest(purchaseId: number, status: RefundRequestStatus) {
  const row = db
    .select({ id: refundRequests.id })
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.purchaseId, purchaseId),
        eq(refundRequests.status, status)
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

function getCompletedLessonCount(learnerId: number, lessonIds: number[]) {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, learnerId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();
  return result?.count ?? 0;
}

// Rewatching a stretch of a lesson does not count twice: only the furthest
// point reached in each lesson adds to the total.
function getSecondsWatched(learnerId: number, lessonIds: number[]) {
  return db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, learnerId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

export function getRefundEligibility(
  learnerId: number,
  courseId: number,
  now: Date
): RefundEligibility {
  const purchase = getLatestPurchase(learnerId, courseId);
  if (!purchase) return { eligible: false, reason: "no-purchase" };

  if (hasRefundRequest(purchase.id, RefundRequestStatus.Approved)) {
    return { eligible: false, reason: "refunded" };
  }

  if (hasRefundRequest(purchase.id, RefundRequestStatus.Pending)) {
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
    const completed = getCompletedLessonCount(learnerId, lessonIds);
    if (completed / lessonIds.length >= REFUND_COMPLETION_LIMIT) {
      return { eligible: false, reason: "completion-limit" };
    }
    if (getSecondsWatched(learnerId, lessonIds) >= REFUND_WATCH_LIMIT_SECONDS) {
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
  learnerId: number;
  courseId: number;
  reason: string;
  now: Date;
}): CreateRefundRequestResult {
  const eligibility = getRefundEligibility(input.learnerId, input.courseId, input.now);
  if (!eligibility.eligible) return { ok: false, reason: eligibility.reason };

  const learner = db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, input.learnerId))
    .get();
  const course = db
    .select({ title: courses.title })
    .from(courses)
    .where(eq(courses.id, input.courseId))
    .get();
  if (!learner || !course) {
    throw new Error(
      `Refund Request for missing learner ${input.learnerId} or course ${input.courseId}`
    );
  }

  db.insert(refundRequests)
    .values({
      purchaseId: eligibility.purchase.id,
      status: RefundRequestStatus.Pending,
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

export function getPendingRefundRequests(learnerId: number) {
  return db
    .select({
      id: refundRequests.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      amountPaid: purchases.amountPaid,
      reason: refundRequests.reason,
      requestedAt: refundRequests.requestedAt,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        eq(purchases.userId, learnerId),
        eq(refundRequests.status, RefundRequestStatus.Pending)
      )
    )
    .all();
}
