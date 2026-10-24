// Appointment reminders: an email to the studio 48 hours before each appointment starts, through the
// same Resend channel as the new-booking alert.
//
// How it works
//   The reminder is SCHEDULED with Resend (`scheduled_at`) as soon as a booking qualifies, so it goes
//   out at the exact 48 hour mark with no cron job needed for the sending. (Vercel's Hobby plan can only
//   run a job once a day, which could never hit the 48 hour mark.) The state of each reminder lives on
//   the booking record (`booking.reminder`). One function, syncBooking(), compares what should be true
//   with what is recorded and schedules, cancels or leaves it alone. It runs when a booking is made,
//   confirmed, rejected or deleted, and once a day from the cron job as a safety net.
//
// Rules
//   - Only bookings that will really happen: confirmed, or pending with a receipt (or nothing to pay).
//     An unpaid booking holding a slot is not an appointment yet.
//   - Booked less than 48 hours ahead: no reminder, and none is ever sent late or immediately.
//   - Rejected, no-show and deleted bookings: any scheduled reminder is cancelled.
//   - If the appointment time changes, the old reminder is cancelled and a new one is scheduled.
//   - Never twice: a conditional write claims the booking before Resend is called, and every request
//     carries a fixed idempotency key.
import { BlobPreconditionFailedError } from "@vercel/blob";
import { DAYS_AHEAD } from "./bookings.js";
import { sleep } from "./http.js";
import { composeReminder, emailConfigured, recipients, resend, senderFor } from "./notify.js";
import { loadSettings } from "./settings.js";
import { listAll, mapLimit, readJson, remove, writeJson } from "./store.js";
import { addDays, dateInTz, zonedToEpoch } from "./time.js";

export const REMIND_BEFORE_MS = 48 * 3_600_000;
export const MAX_ATTEMPTS = 6;
const GRACE_MS = 30_000; // a reminder due this soon counts as already passed
const CLAIM_STALE_MS = 5 * 60_000; // a claim older than this belongs to a worker that died
const POLL_AFTER_MS = 10 * 60_000; // ask Resend how a reminder went this long after it was due
const BACKOFF_MS = [15, 60, 180, 720, 1440].map((m) => m * 60_000);
const TOMBSTONES = "reminders/cancel/";

const bookingPath = (id) => `bookings/${id}.json`;
const log = (event) => console.log(JSON.stringify({ event: "reminder", ...event }));
const SAFE_ID = /^[A-Za-z0-9_-]{6,100}$/;

// ---------- the rules, as a pure function ----------

// valid: should this booking have a reminder at all (ignoring the clock)?
// past:  has the 48 hour mark already gone by?
// record: is the reason worth keeping on the booking so the owner can see why there is no reminder?
export function reminderPlan(b, settings, nowMs) {
  const startMs = zonedToEpoch(b.date, b.time, settings.tz);
  const sendAtMs = startMs - REMIND_BEFORE_MS;
  const out = (valid, reason, record = false) => ({ valid, reason, record, startMs, sendAtMs, past: sendAtMs <= nowMs + GRACE_MS });
  if (settings.notifyReminders === false) return out(false, "reminders are switched off");
  if (b.status !== "pending" && b.status !== "confirmed") return out(false, `the booking is ${b.status}`);
  if (b.status === "pending" && !b.hasReceipt && !(b.deposit === 0)) return out(false, "payment has not been received");
  if (Date.parse(b.createdAt) > sendAtMs) return out(false, "booked less than 48 hours ahead", true);
  return out(true, "");
}

// ---------- saving state on the booking ----------

// Changes only the reminder part of the booking record, safely alongside other edits.
async function saveReminder(id, mutate) {
  for (let i = 0; i < 4; i++) {
    const file = await readJson(bookingPath(id));
    if (!file) return null;
    const next = { ...file.data, reminder: mutate(file.data.reminder, file.data) };
    try {
      await writeJson(bookingPath(id), next, { ifMatch: file.etag });
      return next;
    } catch (err) {
      if (!(err instanceof BlobPreconditionFailedError)) throw err;
      await sleep(30 + Math.random() * 90);
    }
  }
  throw new Error(`could not save the reminder for booking ${id}: it kept changing`);
}

async function claim(file, state) {
  try {
    await writeJson(bookingPath(file.data.id), { ...file.data, reminder: state }, { ifMatch: file.etag });
    return true;
  } catch (err) {
    if (err instanceof BlobPreconditionFailedError) return false; // someone else got there first
    throw err;
  }
}

// ---------- talking to Resend ----------

// true when nothing is left to cancel: cancelled now, already cancelled, already sent, or unknown to Resend
async function cancelEmail(emailId, bookingId, nowMs) {
  const res = await resend(`/emails/${emailId}/cancel`, { method: "POST" });
  // 404, 409, 410 and 422 mean it is already sent, already cancelled or unknown to Resend. Anything else (a bad key, a
  // rate limit, a server error) means it may still go out, so it is kept on the retry list.
  const settled = res.ok || [404, 409, 410, 422].includes(res.status);
  if (!settled) {
    // keep trying from the daily job: a reminder for a booking that no longer exists must not go out
    if (SAFE_ID.test(emailId)) await writeJson(`${TOMBSTONES}${emailId}.json`, { emailId, bookingId, since: nowMs, lastError: res.error }, "overwrite").catch(() => {});
    console.error(`Reminder email ${emailId} for booking ${bookingId} could not be cancelled yet: ${res.error}`);
  }
  return settled;
}

async function schedule(file, plan, settings, ctx) {
  const b = file.data;
  const prev = b.reminder?.for === plan.startMs ? b.reminder : null;
  const attempts = (prev?.attempts ?? 0) + 1;
  const rev = prev ? (prev.rev ?? 0) + (prev.state === "cancelled" ? 1 : 0) : 0;
  const base = { for: plan.startMs, sendAtMs: plan.sendAtMs, rev, attempts };
  if (!(await claim(file, { ...base, state: "scheduling", claimedAt: ctx.nowMs, updatedAt: ctx.nowMs }))) return { id: b.id, action: "busy" };

  const { subject, text, html } = composeReminder(b, settings, ctx.origin);
  const res = await resend("/emails", {
    idempotencyKey: `reminder/${b.id}/${plan.startMs}/${rev}`,
    body: { from: senderFor(settings), to: recipients(settings), subject, text, html, scheduled_at: new Date(plan.sendAtMs).toISOString() },
  });

  if (res.ok && res.data?.id) {
    await saveReminder(b.id, () => ({ ...base, state: "scheduled", emailId: res.data.id, scheduledAtMs: ctx.nowMs, updatedAt: ctx.nowMs }));
    log({ id: b.id, action: "scheduled", sendAt: new Date(plan.sendAtMs).toISOString(), attempts });
    // the booking may have been rejected or deleted while we were talking to Resend
    const again = await readJson(bookingPath(b.id));
    if (again && !reminderPlan(again.data, settings, ctx.nowMs).valid) await cancelReminder(again, "the booking changed while the reminder was being scheduled", ctx);
    return { id: b.id, action: "scheduled" };
  }

  const retryable = res.ok ? true : res.retryable;
  const error = res.ok ? "Resend accepted the request but returned no email id" : res.error;
  const giveUp = !retryable || attempts >= MAX_ATTEMPTS;
  await saveReminder(b.id, () => ({
    ...base,
    state: giveUp ? "failed" : "retry",
    lastError: error,
    ...(giveUp ? {} : { nextTryAt: ctx.nowMs + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] }),
    updatedAt: ctx.nowMs,
  }));
  console.error(`Reminder for booking ${b.id} not scheduled (attempt ${attempts} of ${MAX_ATTEMPTS}, ${giveUp ? "giving up" : "will retry"}): ${error}`);
  return { id: b.id, action: giveUp ? "failed" : "retry", error };
}

async function cancelReminder(file, reason, ctx) {
  const b = file.data;
  const cur = b.reminder;
  if (cur?.emailId) await cancelEmail(cur.emailId, b.id, ctx.nowMs);
  await saveReminder(b.id, (r) => ({ ...r, state: "cancelled", reason, updatedAt: ctx.nowMs }));
  log({ id: b.id, action: "cancelled", reason });
  return { id: b.id, action: "cancelled", reason };
}

// How did it go? Ask Resend once the reminder was due.
async function poll(file, ctx) {
  const b = file.data;
  const cur = b.reminder;
  const res = await resend(`/emails/${cur.emailId}`, { method: "GET" });
  if (!res.ok) return { id: b.id, action: "poll-failed", error: res.error };
  const event = res.data?.last_event;
  let state = null;
  if (["delivered", "sent", "opened", "clicked", "complained"].includes(event)) state = "sent";
  else if (["bounced", "failed"].includes(event)) state = "failed";
  else if (event === "canceled") state = "cancelled";
  if (!state) return { id: b.id, action: "none", reason: `Resend reports "${event}"` };
  await saveReminder(b.id, (r) => ({
    ...r,
    state,
    delivery: event,
    ...(state === "failed" ? { lastError: `Resend reports "${event}"` } : {}),
    ...(state === "cancelled" ? { reason: "cancelled in Resend", manual: true } : {}),
    updatedAt: ctx.nowMs,
  }));
  if (state === "failed") console.error(`Reminder email for booking ${b.id} was not delivered: Resend reports "${event}"`);
  log({ id: b.id, action: state, delivery: event });
  return { id: b.id, action: state };
}

// ---------- the one decision function ----------

export async function syncBooking(file, settings, ctx) {
  const b = file.data;
  const cur = b.reminder;
  const plan = reminderPlan(b, settings, ctx.nowMs);

  if (!plan.valid) {
    const pending = cur && (cur.state === "scheduled" || cur.state === "scheduling" || cur.state === "retry");
    if (pending && cur.state !== "scheduled") return cancelReminder(file, plan.reason, ctx);
    if (pending && cur.sendAtMs > ctx.nowMs) return cancelReminder(file, plan.reason, ctx); // not sent yet: stop it
    if (plan.record && !(cur && cur.for === plan.startMs && (cur.state === "skipped" || cur.state === "sent"))) {
      await saveReminder(b.id, () => ({ for: plan.startMs, sendAtMs: plan.sendAtMs, state: "skipped", reason: plan.reason, updatedAt: ctx.nowMs }));
      return { id: b.id, action: "skipped", reason: plan.reason };
    }
    return { id: b.id, action: "none", reason: plan.reason };
  }

  if (!emailConfigured(settings)) return { id: b.id, action: "none", reason: "email is not set up" };

  if (cur && cur.for === plan.startMs) {
    if (cur.state === "scheduled") return cur.sendAtMs + POLL_AFTER_MS <= ctx.nowMs ? poll(file, ctx) : { id: b.id, action: "none" };
    if (cur.state === "sent" || cur.state === "failed" || cur.state === "skipped") return { id: b.id, action: "none" };
    if (cur.state === "cancelled" && cur.manual) return { id: b.id, action: "none" };
    if (cur.state === "scheduling" && ctx.nowMs - cur.claimedAt < CLAIM_STALE_MS) return { id: b.id, action: "busy" };
    if (cur.state === "retry" && ctx.nowMs < (cur.nextTryAt ?? 0)) return { id: b.id, action: "waiting" };
  }

  // The appointment moved: stop the old reminder, then handle the new time like any other.
  if (cur && cur.for !== plan.startMs && cur.state === "scheduled" && cur.sendAtMs > ctx.nowMs) {
    await cancelEmail(cur.emailId, b.id, ctx.nowMs);
    log({ id: b.id, action: "rescheduled", from: new Date(cur.for).toISOString(), to: new Date(plan.startMs).toISOString() });
  }

  if (plan.past) {
    const reason = "the 48 hour mark had passed before the reminder could be scheduled";
    await saveReminder(b.id, () => ({ for: plan.startMs, sendAtMs: plan.sendAtMs, state: "skipped", reason, updatedAt: ctx.nowMs }));
    return { id: b.id, action: "skipped", reason };
  }
  return schedule(file, plan, settings, ctx);
}

// ---------- entry points ----------

// Used by the booking hooks and the daily job. Never throws.
export async function syncReminder(id, { nowMs = Date.now(), settings, origin } = {}) {
  try {
    if (!process.env.RESEND_API_KEY) return { id, action: "none", reason: "email is not set up" };
    const file = await readJson(bookingPath(id));
    if (!file) return { id, action: "none", reason: "no such booking" };
    return await syncBooking(file, settings ?? (await loadSettings()), { nowMs, origin });
  } catch (err) {
    console.error(`Reminder sync failed for booking ${id}:`, err?.message);
    return { id, action: "error", error: err?.message };
  }
}

// A booking is about to be deleted: its reminder must not outlive it.
export async function cancelReminderForDelete(booking, { nowMs = Date.now() } = {}) {
  try {
    const cur = booking.reminder;
    if (cur?.state === "scheduled" && cur.emailId && cur.sendAtMs > nowMs) await cancelEmail(cur.emailId, booking.id, nowMs);
  } catch (err) {
    console.error(`Could not cancel the reminder of booking ${booking.id}:`, err?.message);
  }
}

// The daily safety net: schedule anything that should have a reminder and does not, cancel anything that
// should not have one, settle how past reminders went, and retry cancellations that failed.
export async function reconcile({ nowMs = Date.now(), origin, budgetMs = 8000 } = {}) {
  const started = Date.now();
  const settings = await loadSettings();
  const summary = { ranAt: new Date(nowMs).toISOString(), emailConfigured: emailConfigured(settings), bookings: 0, actions: {}, tombstones: 0, partial: false };
  if (!summary.emailConfigured) return { ...summary, note: "Email is not set up (RESEND_API_KEY), so there is nothing to schedule." };
  const outOfTime = () => Date.now() - started > budgetMs;

  // 1. cancellations that failed earlier
  for (const blob of await listAll(TOMBSTONES)) {
    if (outOfTime()) { summary.partial = true; break; }
    const t = await readJson(blob.pathname);
    if (!t) continue;
    summary.tombstones++;
    if (await cancelEmail(t.data.emailId, t.data.bookingId, nowMs)) await remove(blob.pathname);
  }

  // 2. every booking that holds a slot from two days ago to the end of the booking window
  const today = dateInTz(nowMs, settings.tz);
  const dates = Array.from({ length: DAYS_AHEAD + 3 }, (_, i) => addDays(today, i - 2));
  const days = await mapLimit(dates, 6, (date) => readJson(`days/${date}.json`));
  const ids = [...new Set(days.flatMap((d) => d?.data.entries.map((e) => e.id) ?? []))];
  summary.bookings = ids.length;
  const results = await mapLimit(ids, 4, async (id) => {
    if (outOfTime()) { summary.partial = true; return null; }
    return syncReminder(id, { nowMs, settings, origin });
  });
  for (const r of results) if (r) summary.actions[r.action] = (summary.actions[r.action] ?? 0) + 1;
  return summary;
}
