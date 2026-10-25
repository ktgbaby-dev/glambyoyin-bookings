// Shared by the scheduled jobs in api/cron/. Vercel calls them from the cron entry in vercel.json and sends
// `Authorization: Bearer <CRON_SECRET>`. Anything else, without that header, is refused.
import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http.js";
import { runBackup } from "./backup.js";
import { notifyBackupFailed } from "./notify.js";
import { loadSettings } from "./settings.js";

export function authorised(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) throw new HttpError(503, "not_configured", "The scheduled job is not set up (CRON_SECRET is missing).");
  const given = request.headers.get("authorization") || "";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  if (!timingSafeEqual(a, b)) throw new HttpError(401, "unauthorized", "Not allowed.");
}

export function originOf(request) {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || new URL(request.url).host;
  return `https://${host}`;
}

// The nightly backup. A failure is logged and emailed to the studio; it never stops the rest of the job.
export async function nightlyBackup(origin) {
  const result = await runBackup({ by: "daily" });
  if (!result.ok && result.reason === "failed") {
    const settings = await loadSettings().catch(() => null);
    if (settings) await notifyBackupFailed({ settings, origin, message: result.message }).catch(() => {});
  }
  return result;
}
