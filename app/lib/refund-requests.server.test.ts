import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;

// `~/db` opens data.db on first use; point it at the in-memory database.
vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  createRefundRequest,
  getPendingRefundRequests,
  getRefundEligibility,
} from "./refund-requests.server";

const PURCHASED_AT = new Date(2026, 0, 10, 23, 0);

function daysAfterPurchase(days: number, hour = 12) {
  return new Date(2026, 0, 10 + days, hour, 0);
}

let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
  testDb
    .update(schema.courses)
    .set({ price: 10000 })
    .run();
});

function buy(amountPaid: number, country: string | null = "US") {
  return testDb
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid,
      country,
      createdAt: PURCHASED_AT.toISOString(),
    })
    .returning()
    .get();
}

function addLessons(count: number) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module", position: 1 })
    .returning()
    .get();
  return Array.from({ length: count }, (_, i) =>
    testDb
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: `Lesson ${i + 1}`, position: i + 1 })
      .returning()
      .get()
  );
}

function complete(lessonId: number) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId: base.user.id,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
    })
    .run();
}

function watch(lessonId: number, positionSeconds: number) {
  testDb
    .insert(schema.videoWatchEvents)
    .values({
      userId: base.user.id,
      lessonId,
      eventType: "progress",
      positionSeconds,
    })
    .run();
}

function addSeats(purchaseId: number, count: number, claimed = 0) {
  const team = testDb.insert(schema.teams).values({}).returning().get();
  for (let i = 0; i < count; i++) {
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        purchaseId,
        code: `seat-${purchaseId}-${i}`,
        redeemedAt: i < claimed ? PURCHASED_AT.toISOString() : null,
      })
      .run();
  }
}

function addRefundRequest(purchaseId: number, status: schema.RefundStatus) {
  testDb
    .insert(schema.refunds)
    .values({ purchaseId, status, reason: "It was not what I expected." })
    .run();
}

describe("getRefundEligibility", () => {
  it("lets a learner inside the Refund Window send a Refund Request for the amount they paid", () => {
    buy(10000);

    const eligibility = getRefundEligibility(
      base.user.id,
      base.course.id,
      daysAfterPurchase(3)
    );

    expect(eligibility).toMatchObject({
      eligible: true,
      refundAmount: 10000,
      lastDayInWindow: "2026-01-24",
    });
  });

  it("keeps the Refund Window open until the end of its last day", () => {
    buy(10000);

    expect(
      getRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(14, 23))
    ).toMatchObject({ eligible: true });
  });

  it("refuses once the Refund Window has closed", () => {
    buy(10000);

    expect(
      getRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(15, 0))
    ).toEqual({ eligible: false, reason: "window-closed" });
  });

  it("refuses once the learner has completed half of the lessons", () => {
    buy(10000);
    const lessons = addLessons(4);
    complete(lessons[0].id);
    complete(lessons[1].id);

    expect(
      getRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(3))
    ).toEqual({ eligible: false, reason: "completion-limit" });
  });

  it("allows a learner who has completed less than half of the lessons", () => {
    buy(10000);
    const lessons = addLessons(4);
    complete(lessons[0].id);

    expect(
      getRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(3))
    ).toMatchObject({ eligible: true });
  });

  it("refuses once the learner has watched two hours, counting only the furthest point in each lesson", () => {
    buy(10000);
    const [first, second] = addLessons(4);
    watch(first.id, 1800);
    watch(first.id, 3600);
    watch(second.id, 3600);

    expect(
      getRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(3))
    ).toEqual({ eligible: false, reason: "watch-limit" });
  });

  it("does not count rewatching the same part of a lesson towards the watch limit", () => {
    buy(10000);
    const [first, second] = addLessons(4);
    watch(first.id, 3600);
    watch(first.id, 3600);
    watch(second.id, 3599);

    expect(
      getRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(3))
    ).toMatchObject({ eligible: true });
  });

  it("refuses a Purchase with a Claimed Seat", () => {
    const purchase = buy(50000);
    addSeats(purchase.id, 5, 1);

    expect(
      getRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(3))
    ).toEqual({ eligible: false, reason: "claimed-seat" });
  });

  it("refuses while a Refund Request for the Purchase is Pending", () => {
    const purchase = buy(10000);
    addRefundRequest(purchase.id, schema.RefundStatus.Pending);

    expect(
      getRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(3))
    ).toEqual({ eligible: false, reason: "pending-request" });
  });

  describe("the Refund Amount", () => {
    it("is what the learner paid, even after the course price rises", () => {
      buy(10000);
      testDb.update(schema.courses).set({ price: 15000 }).run();

      expect(
        getRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(3))
      ).toMatchObject({ eligible: true, refundAmount: 10000 });
    });

    it("is the full total for a team Purchase with no Claimed Seats", () => {
      const purchase = buy(50000);
      addSeats(purchase.id, 5);

      expect(
        getRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(3))
      ).toMatchObject({ eligible: true, refundAmount: 50000 });
    });

    it("is the purchasing-power price that was paid, not the list price", () => {
      buy(3000, "IN");

      expect(
        getRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(3))
      ).toMatchObject({ eligible: true, refundAmount: 3000 });
    });
  });

  it("allows a new Refund Request after a Declined one", () => {
    const purchase = buy(10000);
    addRefundRequest(purchase.id, schema.RefundStatus.Declined);

    expect(
      getRefundEligibility(base.user.id, base.course.id, daysAfterPurchase(3))
    ).toMatchObject({ eligible: true });
  });
});

describe("createRefundRequest", () => {
  const reason = "The course did not cover what I needed.";

  it("saves a Pending Refund Request and emails the learner the Refund Amount", () => {
    buy(3000, "IN");

    const result = createRefundRequest({
      userId: base.user.id,
      courseId: base.course.id,
      reason,
      now: daysAfterPurchase(3),
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.email.to).toBe("test@example.com");
    expect(result.email.subject).toBe("Refund requested — Test Course");
    expect(result.email.body).toContain("we will refund $30.00");

    expect(getPendingRefundRequests(base.user.id)).toMatchObject([
      { courseTitle: "Test Course", amountPaid: 3000, reason },
    ]);
  });

  it("refuses a learner past the completion limit and saves nothing", () => {
    buy(10000);
    const lessons = addLessons(2);
    complete(lessons[0].id);

    const result = createRefundRequest({
      userId: base.user.id,
      courseId: base.course.id,
      reason,
      now: daysAfterPurchase(3),
    });

    expect(result).toEqual({ ok: false, reason: "completion-limit" });
    expect(getPendingRefundRequests(base.user.id)).toEqual([]);
  });

  it("refuses a second Refund Request while the first is Pending", () => {
    buy(10000);
    const request = {
      userId: base.user.id,
      courseId: base.course.id,
      reason,
      now: daysAfterPurchase(3),
    };

    createRefundRequest(request);

    expect(createRefundRequest(request)).toEqual({
      ok: false,
      reason: "pending-request",
    });
    expect(getPendingRefundRequests(base.user.id)).toHaveLength(1);
  });
});
