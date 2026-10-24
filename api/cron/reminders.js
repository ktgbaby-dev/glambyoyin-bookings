// GET or POST /api/cron/reminders: the daily safety net for appointment reminders (see _lib/reminders.js).
// Vercel calls it from the cron entry in vercel.json and sends `Authorization: Bearer <CRON_SECRET>`.
// Anything else, without that header, is refused.
import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError, handle, json } from "../_lib/http.js";
import { reconcile } from "../_lib/reminders.js";

function authorised(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) throw new HttpError(503, "not_configured", "The scheduled job is not set up (CRON_SECRET is missing).");
  const given = request.headers.get("authorization") || "";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  if (!timingSafeEqual(a, b)) throw new HttpError(401, "unauthorized", "Not allowed.");
}

async function run(request) {
  authorised(request);
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || new URL(request.url).host;
  const summary = await reconcile({ origin: `https://${host}` });
  console.log(JSON.stringify({ event: "reminders-run", ...summary }));
  return json(summary);
}

export const GET = (request) => handle(request, ["GET"], () => run(request));
export const POST = (request) => handle(request, ["POST"], () => run(request));
