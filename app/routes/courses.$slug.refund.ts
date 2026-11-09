import { data, redirect } from "react-router";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/courses.$slug.refund";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { courses } from "~/db/schema";
import { parseFormData, parseParams } from "~/lib/validation";
import {
  createRefundRequest,
  type RefundRefusal,
} from "~/lib/refund-requests.server";

const refundParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundActionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

const refusalResponses: Record<
  RefundRefusal,
  { message: string; status: number }
> = {
  "no-purchase": { message: "You have not bought this course.", status: 403 },
  refunded: {
    message: "This purchase has already been refunded.",
    status: 409,
  },
  "pending-request": {
    message: "You already have a pending refund request for this purchase.",
    status: 409,
  },
  "claimed-seat": {
    message: "A purchase with a claimed seat cannot be refunded.",
    status: 403,
  },
  "window-closed": { message: "The refund window has closed.", status: 403 },
  "completion-limit": {
    message: "You have completed too much of this course to request a refund.",
    status: 403,
  },
  "watch-limit": {
    message: "You have watched too much of this course to request a refund.",
    status: 403,
  },
};

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to request a refund.", { status: 401 });
  }

  const { slug } = parseParams(params, refundParamsSchema);
  const course = db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.slug, slug))
    .get();

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const parsed = parseFormData(await request.formData(), refundActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  const result = createRefundRequest({
    userId: currentUserId,
    courseId: course.id,
    reason: parsed.data.reason,
    now: new Date(),
  });

  if (!result.ok) {
    const { message, status } = refusalResponses[result.reason];
    throw data(message, { status });
  }

  // No mail transport is wired up yet, so the email goes to the server log.
  console.log(
    `[email] to=${result.email.to} subject=${result.email.subject}\n${result.email.body}`
  );

  return redirect("/settings");
}
