// Owner sessions: a signed cookie, no server-side session store.
//
//   logins exist  ->  v2.<userId>.<expiry>.<sessionVersion>.HMAC-SHA256(SESSION_SECRET, everything before it)
//   no logins yet ->  <expiry>.HMAC-SHA256(SESSION_SECRET, expiry)        (legacy: one shared password)
//
// A v2 cookie only counts while the login still exists and its sessionVersion
// still matches, so changing a password, resetting one or removing a login ends
// every session that login had. OWNER_PASSWORD stays valid in two ways: as the
// single password in legacy mode, and afterwards as a recovery password that
// opens any admin login (so a forgotten admin password never locks everyone out).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http.js";
import { loadUsers } from "./users.js";

export const COOKIE = "gbo_session";
export const SESSION_SECONDS = 30 * 24 * 60 * 60;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new HttpError(503, "not_configured", "Owner sign-in isn't set up yet.");
  return s;
}

const sign = (payload) => createHmac("sha256", secret()).update(String(payload)).digest("hex");

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

export const recoveryConfigured = () => !!process.env.OWNER_PASSWORD;

// The stand-in "login" while the site still has a single shared password.
export const LEGACY_USER = Object.freeze({
  id: "legacy", username: "owner", name: "Owner", role: "admin", mustChange: false, legacy: true,
});

const cookieAttrs = "Path=/; HttpOnly; Secure; SameSite=Lax";
const setCookie = (value) => `${COOKIE}=${value}; Max-Age=${SESSION_SECONDS}; ${cookieAttrs}`;

export function sessionCookie(user = LEGACY_USER) {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  if (user.legacy) return setCookie(`${expiry}.${sign(expiry)}`);
  const body = `v2.${user.id}.${expiry}.${user.sessionVersion ?? 0}`;
  return setCookie(`${body}.${sign(body)}`);
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

// The signed-in login, or null.
export async function getSession(request) {
  try {
    const raw = readCookie(request, COOKIE);
    if (!raw) return null;
    const parts = raw.split(".");
    const nowSec = Math.floor(Date.now() / 1000);

    if (parts[0] === "v2") {
      if (parts.length !== 5) return null;
      const [, id, expiry, version, mac] = parts;
      if (!id || !/^\d{9,12}$/.test(expiry) || !/^\d{1,9}$/.test(version) || !mac) return null;
      if (Number(expiry) < nowSec) return null;
      if (!safeEqual(mac, sign(`v2.${id}.${expiry}.${version}`))) return null;
      const list = await loadUsers();
      const user = list?.users.find((u) => u.id === id);
      if (!user || (user.sessionVersion ?? 0) !== Number(version)) return null;
      return user;
    }

    // legacy cookie: only while no logins exist
    if (parts.length !== 2) return null;
    const [expiry, mac] = parts;
    if (!/^\d{9,12}$/.test(expiry) || !mac || Number(expiry) < nowSec) return null;
    if (!safeEqual(mac, sign(expiry))) return null;
    if (await loadUsers()) return null;
    return LEGACY_USER;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return null;
  }
}

// `allowMustChange`: the few endpoints a login with a temporary password may use (to choose its own).
export async function requireOwner(request, { allowMustChange = false } = {}) {
  const user = await getSession(request);
  if (!user) throw new HttpError(401, "unauthorized", "Please sign in.");
  if (user.mustChange && !allowMustChange) {
    throw new HttpError(403, "must_change", "Please choose your own password first.");
  }
  return user;
}

export async function requireAdmin(request) {
  const user = await requireOwner(request);
  if (user.role !== "admin") throw new HttpError(403, "forbidden", "Only a login that manages logins can do that.");
  return user;
}
