// Owner session: a signed cookie, `expiry.HMAC-SHA256(SESSION_SECRET, expiry)`.
// No server-side session store; the signature is the proof.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http.js";

export const COOKIE = "gbo_session";
export const SESSION_SECONDS = 30 * 24 * 60 * 60;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new HttpError(503, "not_configured", "Owner sign-in isn't set up yet.");
  return s;
}

const sign = (expiry) => createHmac("sha256", secret()).update(String(expiry)).digest("hex");

// Hash both sides first so lengths always match, then compare in constant time.
function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function passwordMatches(input) {
  const expected = process.env.OWNER_PASSWORD;
  if (!expected) throw new HttpError(503, "not_configured", "Owner sign-in isn't set up yet.");
  return safeEqual(input ?? "", expected);
}

const cookieAttrs = "Path=/; HttpOnly; Secure; SameSite=Lax";

export function sessionCookie() {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  return `${COOKIE}=${expiry}.${sign(expiry)}; Max-Age=${SESSION_SECONDS}; ${cookieAttrs}`;
}

export function clearedCookie() {
  return `${COOKIE}=; Max-Age=0; ${cookieAttrs}`;
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function isOwner(request) {
  try {
    const raw = readCookie(request, COOKIE);
    if (!raw) return false;
    const [expiry, mac, ...rest] = raw.split(".");
    if (rest.length || !/^\d{9,12}$/.test(expiry || "") || !mac) return false;
    if (Number(expiry) < Math.floor(Date.now() / 1000)) return false;
    return safeEqual(mac, sign(expiry));
  } catch {
    return false;
  }
}

export function requireOwner(request) {
  if (!isOwner(request)) throw new HttpError(401, "unauthorized", "Please sign in.");
}
