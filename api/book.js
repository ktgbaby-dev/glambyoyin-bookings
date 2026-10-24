// POST /api/book: validate, store the receipt and booking, then reserve the slot.
// The slot reservation is last and is the guard: if it loses a race, the
// booking and receipt written a moment earlier are removed again.
import { clientView, newCode, newId, releaseSlot, reserveSlot, validateBooking } from "./_lib/bookings.js";
import { handle, json, readJsonBody, requireSameOrigin } from "./_lib/http.js";
import { notifyNewBooking } from "./_lib/notify.js";
import { rateLimit } from "./_lib/ratelimit.js";
import { loadSettings } from "./_lib/settings.js";
import { remove, writeFile, writeJson } from "./_lib/store.js";

const MAX_BODY = 470_000;

export function POST(request) {
  return handle(request, ["POST"], async () => {
    requireSameOrigin(request);
    await rateLimit(request, { name: "book", max: 12, windowSec: 600 }); // a real client books once or twice
    const input = await readJsonBody(request, MAX_BODY);
    const settings = await loadSettings();
    const nowMs = Date.now();
    const { fields, receipt } = validateBooking(input, settings, nowMs);

    const id = newId();
    const now = new Date(nowMs).toISOString();
    const booking = {
      id,
      code: newCode(),
      status: "pending",
      ...fields,
      hasReceipt: !!receipt,
      receiptType: receipt?.type ?? null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      if (receipt) await writeFile(`proofs/${id}`, receipt.buffer, receipt.type);
      await writeJson(`bookings/${id}.json`, booking, "create");
      await reserveSlot({ date: fields.date, time: fields.time, mins: fields.mins, id, holdUntil: fields.holdUntil, nowMs });
    } catch (err) {
      await Promise.allSettled([
        remove(`bookings/${id}.json`),
        remove(`proofs/${id}`),
        releaseSlot(fields.date, id),
      ]);
      throw err;
    }

    // Tell the studio. Never throws and never delays long: the booking is already safe.
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || new URL(request.url).host;
    await notifyNewBooking({ booking, settings, origin: `https://${host}` });

    return json({ booking: clientView(booking) });
  });
}
