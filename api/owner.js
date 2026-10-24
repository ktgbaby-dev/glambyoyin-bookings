// /api/owner (owner only): GET lists bookings and settings,
// POST runs an action: { action: "status" | "delete" | "settings", ... }.
import { BlobPreconditionFailedError } from "@vercel/blob";
import { requireOwner } from "./_lib/auth.js";
import { releaseSlot } from "./_lib/bookings.js";
import { HttpError, ID_RE, handle, json, readJsonBody, requireSameOrigin } from "./_lib/http.js";
import { loadSettings, saveSettings } from "./_lib/settings.js";
import { listAll, mapLimit, readJson, remove, writeJson } from "./_lib/store.js";

const MAX_LIST = 400;
const TRANSITIONS = {
  pending: ["confirmed", "rejected"],
  confirmed: ["done", "noshow"],
};
const RELEASES_SLOT = new Set(["rejected", "noshow"]);

async function listBookings() {
  const blobs = await listAll("bookings/");
  const newest = blobs.map((b) => b.pathname).sort().reverse().slice(0, MAX_LIST);
  const files = await mapLimit(newest, 12, (path) => readJson(path));
  return files.filter(Boolean).map((f) => f.data);
}

function needId(body) {
  if (!ID_RE.test(body.id || "")) throw new HttpError(400, "invalid", "That booking id isn't valid.");
  return body.id;
}

async function changeStatus(body) {
  const id = needId(body);
  const next = String(body.status || "");
  const file = await readJson(`bookings/${id}.json`);
  if (!file) throw new HttpError(404, "not_found", "That booking no longer exists.");
  const booking = file.data;

  // Repeating a release is harmless, so a failed release can be retried.
  if (booking.status === next && RELEASES_SLOT.has(next)) {
    await releaseSlot(booking.date, id);
    return booking;
  }
  if (!(TRANSITIONS[booking.status] || []).includes(next)) {
    throw new HttpError(409, "bad_transition", `A ${booking.status} booking can't be marked ${next}.`);
  }

  const updated = { ...booking, status: next, updatedAt: new Date().toISOString() };
  try {
    await writeJson(`bookings/${id}.json`, updated, { ifMatch: file.etag });
  } catch (err) {
    if (err instanceof BlobPreconditionFailedError) {
      throw new HttpError(409, "changed", "That booking was just changed. Refresh and try again.");
    }
    throw err;
  }
  if (RELEASES_SLOT.has(next)) await releaseSlot(booking.date, id);
  return updated;
}

async function deleteBooking(body) {
  const id = needId(body);
  const file = await readJson(`bookings/${id}.json`);
  if (file) await releaseSlot(file.data.date, id);
  await remove(`proofs/${id}`);
  await remove(`bookings/${id}.json`);
}

export function GET(request) {
  return handle(request, ["GET"], async () => {
    await requireOwner(request);
    const [bookings, settings] = await Promise.all([listBookings(), loadSettings()]);
    return json({ bookings, settings, now: Date.now() });
  });
}

export function POST(request) {
  return handle(request, ["POST"], async () => {
    await requireOwner(request);
    requireSameOrigin(request);
    const body = await readJsonBody(request, 60_000);
    switch (body.action) {
      case "status":
        return json({ booking: await changeStatus(body) });
      case "delete":
        await deleteBooking(body);
        return json({ deleted: true });
      case "settings":
        return json({ settings: await saveSettings(body.settings || {}) });
      default:
        throw new HttpError(400, "invalid", "Unknown action.");
    }
  });
}
