// Per-visitor rate limiting for the few endpoints worth abusing (booking, sign-in).
// A counter per hashed address and time window lives in the private store: rl/<name>/<window>/<hash>.json.
// Raw addresses are never stored. If the store hiccups, the visitor is let through: a limiter must
// never be the reason a real client can't book.
import { createHash } from "node:crypto";
import { HttpError } from "./http.js";
import { listAll, readJson, remove, writeJson } from "./store.js";

// Vercel replaces x-forwarded-for with the real client address, so it can't be spoofed from outside.
export function clientIp(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  return (forwarded ? forwarded.split(",")[0] : request.headers.get("x-real-ip") || "").trim() || null;
}

const hashOf = (ip) => createHash("sha256").update(`gbo-rl:${ip}`).digest("hex").slice(0, 24);
const TOO_MANY = () => new HttpError(429, "too_many_requests", "Too many attempts from this connection. Please wait a few minutes and try again.");

// Counts this request; throws a 429 once `max` requests have been made in the current window.
export async function rateLimit(request, { name, max, windowSec, nowMs = Date.now() }) {
  const ip = clientIp(request);
  if (!ip) return;
  const slot = Math.floor(nowMs / (windowSec * 1000));
  const path = `rl/${name}/${slot}/${hashOf(ip)}.json`;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await readJson(path);
      const n = cur?.data.n ?? 0;
      if (n >= max) throw TOO_MANY();
      try {
        await writeJson(path, { n: n + 1 }, cur ? { ifMatch: cur.etag } : "create");
        break;
      } catch {
        // someone else counted at the same moment: read again
      }
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error("rate limiter unavailable, letting the request through:", err.message);
    return;
  }
  // now and then, sweep away counters from windows that are over
  if (Math.random() < 0.02) await sweep(name, slot).catch(() => {});
}

async function sweep(name, currentSlot) {
  const blobs = await listAll(`rl/${name}/`);
  for (const b of blobs) {
    const slot = Number(b.pathname.split("/")[2]);
    if (Number.isFinite(slot) && slot < currentSlot - 1) await remove(b.pathname);
  }
}
