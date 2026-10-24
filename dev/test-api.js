// API tests: run with `npm test`. They call the real api/ handlers against the
// in-memory Blob mock (see dev/mock-blob.js).
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { __mock } from "@vercel/blob"; // resolved to the mock by dev/loader.js

process.env.OWNER_PASSWORD = "test-owner-password";
process.env.SESSION_SECRET = "test-session-secret-test-session-secret";

const pub = await import("../api/public.js");
const book = await import("../api/book.js");
const status = await import("../api/status.js");
const auth = await import("../api/auth.js");
const owner = await import("../api/owner.js");
const proof = await import("../api/proof.js");
const { validateBooking } = await import("../api/_lib/bookings.js");
const { DEFAULT_SETTINGS } = await import("../api/_lib/settings.js");
const time = await import("../api/_lib/time.js");

beforeEach(() => __mock.reset());

// ---------- helpers ----------

async function call(fn, { method = "GET", path = "/", body, cookie, headers = {}, raw } = {}) {
  const h = new Headers(headers);
  if (cookie) h.set("cookie", cookie);
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) {
    h.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  const res = await fn(new Request(`http://localhost${path}`, { method, headers: h, body: payload }));
  const text = await res.clone().text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* binary */ }
  return { status: res.status, data, res, headers: res.headers };
}

const jpeg = (size = 2000) => {
  const b = Buffer.alloc(size, 7);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b);
  return b;
};
const receipt = (size) => ({ type: "image/jpeg", data: jpeg(size).toString("base64") });

// The next open day (from tomorrow) with its opening time, in studio time.
async function bookable(offset = 1, s = DEFAULT_SETTINGS) {
  const today = time.dateInTz(Date.now(), s.tz);
  for (let i = offset; i < 20; i++) {
    const date = time.addDays(today, i);
    const h = s.hours[time.weekdayKey(date)];
    if (h) return { date, open: h.open, close: h.close };
  }
  throw new Error("no open day found");
}

const base = (extra = {}) => ({
  serviceId: "soft-glam", name: "Ada Obi", phone: "08137500330", payer: "Ada Obi", note: "", ...extra,
});

async function bookAt(date, t, extra = {}) {
  return call(book.POST, { method: "POST", path: "/api/book", body: base({ date, time: t, ...extra }) });
}

async function ownerCookie() {
  const r = await call(auth.POST, { method: "POST", body: { password: process.env.OWNER_PASSWORD } });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie").split(";")[0];
}

// ---------- time helpers ----------

test("studio time is Lagos time (UTC+1), whatever the machine zone", () => {
  assert.equal(new Date(time.zonedToEpoch("2026-10-24", "09:00", "Africa/Lagos")).toISOString(), "2026-10-24T08:00:00.000Z");
  assert.equal(time.dateInTz(Date.UTC(2026, 9, 24, 23, 30), "Africa/Lagos"), "2026-10-25"); // 00:30 next day in Lagos
  assert.equal(time.weekdayKey("2026-10-27"), "tue");
  assert.equal(time.addDays("2026-10-31", 1), "2026-11-01");
});

// ---------- validation (pure, fixed clock) ----------

test("validateBooking enforces every rule, and prices come from the server", () => {
  const s = DEFAULT_SETTINGS;
  const now = Date.UTC(2026, 9, 27, 7, 0); // Tue 27 Oct 2026, 08:00 Lagos
  const ok = (over) => validateBooking({ ...base(), date: "2026-10-27", time: "10:00", ...over }, s, now);
  const rejects = (over, field) => assert.throws(() => ok(over), (e) => e.status === 400 && (!field || e.field === field));

  const good = ok({ price: 1, deposit: 1, depositPct: 1 }); // tampering is ignored
  assert.equal(good.fields.price, 25000);
  assert.equal(good.fields.deposit, 12500);
  assert.equal(good.fields.balance, 12500);

  rejects({ time: "09:30" }, "time"); // under 2 hours' notice
  rejects({ serviceId: "nope" }, "service");
  rejects({ date: "2026-10-26" }, "date"); // yesterday
  rejects({ date: "2026-11-02" }, "date"); // Monday: closed
  // The window is today + 20 days. From Wed 28 Oct: Tue 17 Nov is the last bookable day, Wed 18 Nov is too far.
  const wed = Date.UTC(2026, 9, 28, 7, 0);
  const onWed = (date) => () => validateBooking({ ...base(), date, time: "10:00" }, s, wed);
  assert.doesNotThrow(onWed("2026-11-17"));
  assert.throws(onWed("2026-11-18"), (e) => e.status === 400 && e.field === "date");
  rejects({ date: "2026-02-30" }, "date"); // not a real date
  rejects({ time: "10:15" }, "time"); // off the 30-minute grid
  rejects({ time: "8:00" }, "time");
  rejects({ date: "2026-11-01", time: "11:30" }, "time"); // Sunday opens 12:00
  assert.doesNotThrow(() => ok({ date: "2026-11-01", time: "12:00" }));
  assert.doesNotThrow(() => ok({ date: "2026-11-01", time: "15:30" })); // 90 min ends exactly at close
  rejects({ date: "2026-11-01", time: "16:00" }, "time"); // would run past close
  rejects({ name: "A" }, "name");
  rejects({ phone: "12345" }, "phone");
  rejects({ phone: "abcdefghijk" }, "phone");
  rejects({ payer: "" }, "payer");
  rejects({ note: "x".repeat(301) }, "note");
});

test("receipts must be real small images", () => {
  const s = DEFAULT_SETTINGS;
  const now = Date.UTC(2026, 9, 27, 7, 0);
  const withReceipt = (r) => () => validateBooking({ ...base(), date: "2026-10-27", time: "10:00", receipt: r }, s, now);
  assert.doesNotThrow(withReceipt(receipt(2000)));
  assert.throws(withReceipt({ type: "application/pdf", data: "AAAA" }), (e) => e.status === 400);
  assert.throws(withReceipt({ type: "image/jpeg", data: Buffer.alloc(2000).toString("base64") }), (e) => e.status === 400); // no JPEG magic
  assert.throws(withReceipt({ type: "image/png", data: jpeg().toString("base64") }), (e) => e.status === 400); // type/bytes mismatch
  assert.throws(withReceipt(receipt(330_000)), (e) => e.status === 400); // base64 over the cap
  assert.throws(withReceipt({ type: "image/jpeg", data: "not base64 !!" }), (e) => e.status === 400);
});

// ---------- public ----------

test("/api/public gives settings and taken slots only, never client details", async () => {
  const { date, open } = await bookable();
  await bookAt(date, open, { name: "Secret Client", phone: "08011112222", note: "private note" });
  const r = await call(pub.GET, { path: "/api/public" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.taken, [{ date, time: open, mins: 90 }]);
  const text = JSON.stringify(r.data);
  for (const leak of ["Secret Client", "08011112222", "private note", "payer", "code"]) assert.ok(!text.includes(leak), `leaked ${leak}`);
  assert.equal(r.data.settings.bank.accountNumber, "0250147305");
  assert.ok(!("confirmed" in r.data.settings));
});

// ---------- booking ----------

test("a booking with a receipt returns a code and stores everything", async () => {
  const { date, open } = await bookable();
  const r = await bookAt(date, open, { receipt: receipt(5000) });
  assert.equal(r.status, 200);
  const b = r.data.booking;
  assert.match(b.code, /^[A-HJKMNP-Z2-9]{6}$/);
  assert.equal(b.status, "pending");
  assert.equal(b.hasReceipt, true);
  assert.equal(b.deposit, 12500);
  assert.equal(__mock.paths("bookings/").length, 1);
  assert.equal(__mock.paths("proofs/").length, 1);
  assert.equal(__mock.paths("days/").length, 1);
});

test("a booking without a receipt is allowed", async () => {
  const { date, open } = await bookable();
  const r = await bookAt(date, open);
  assert.equal(r.status, 200);
  assert.equal(r.data.booking.hasReceipt, false);
  assert.equal(__mock.paths("proofs/").length, 0);
});

test("overlapping bookings are refused; back-to-back ones are fine", async () => {
  const { date, open } = await bookable();
  const at = (mins) => time.fromMins(time.toMins(open) + mins);
  assert.equal((await bookAt(date, at(0))).status, 200); // 90 min
  assert.equal((await bookAt(date, at(30))).status, 409); // starts inside
  assert.equal((await bookAt(date, at(60))).status, 409); // starts inside
  assert.equal((await bookAt(date, at(90))).status, 200); // starts exactly at the end
  // a service that would run into the next booking is refused too
  assert.equal((await bookAt(date, at(180), { serviceId: "full-glam" })).status, 200); // 120 min, free
  const clash = await bookAt(date, at(150), { serviceId: "full-glam" }); // would overlap the 180 one
  assert.equal(clash.status, 409);
});

test("two simultaneous bookings for one slot: exactly one 200 and one 409 (15 rounds)", async () => {
  const { date, open } = await bookable();
  for (let round = 0; round < 15; round++) {
    __mock.reset();
    const [a, b] = await Promise.all([
      bookAt(date, open, { name: "Client A", receipt: receipt(3000) }),
      bookAt(date, open, { name: "Client B", receipt: receipt(3000) }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], `round ${round}: ${a.status}/${b.status}`);
    // the loser leaves nothing behind
    assert.equal(__mock.paths("bookings/").length, 1, `round ${round}: stray booking`);
    assert.equal(__mock.paths("proofs/").length, 1, `round ${round}: stray receipt`);
  }
});

test("ten people racing for one slot: one winner, nine told it's taken", async () => {
  const { date, open } = await bookable();
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => bookAt(date, open, { name: `Client ${i}`, receipt: receipt(2500) })));
  const codes = results.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 200).length, 1, codes.join());
  assert.equal(codes.filter((c) => c === 409).length, 9, codes.join());
  assert.equal(__mock.paths("bookings/").length, 1);
  assert.equal(__mock.paths("proofs/").length, 1);
});

test("overlapping-but-different start times also race safely", async () => {
  const { date, open } = await bookable();
  const later = time.fromMins(time.toMins(open) + 30);
  const [a, b] = await Promise.all([bookAt(date, open), bookAt(date, later)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});

test("different slots on the same day all succeed under contention", async () => {
  const { date, open } = await bookable();
  // 60-minute service at 0/60/120/180: fits even on the shortest day (Sunday, 5 hours).
  const slots = [0, 60, 120, 180].map((m) => time.fromMins(time.toMins(open) + m));
  const results = await Promise.all(slots.map((t, i) => bookAt(date, t, { name: `Client ${i}`, serviceId: "lash-refill" })));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200]);
  const day = (await call(pub.GET, { path: "/api/public" })).data.taken.filter((x) => x.date === date);
  assert.equal(day.length, 4);
});

test("POST needs JSON and the same origin", async () => {
  const { date, open } = await bookable();
  const wrongType = await call(book.POST, { method: "POST", raw: "x=1", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(wrongType.status, 415);
  const crossSite = await call(book.POST, {
    method: "POST", body: base({ date, time: open }), headers: { origin: "https://evil.example", host: "localhost" },
  });
  assert.equal(crossSite.status, 403);
  const badJson = await call(book.POST, { method: "POST", raw: "{nope", headers: { "content-type": "application/json" } });
  assert.equal(badJson.status, 400);
  assert.equal(__mock.paths("bookings/").length, 0);
});

// ---------- status ----------

test("a client can check their own booking; a wrong code is a 404", async () => {
  const { date, open } = await bookable();
  const { booking } = (await bookAt(date, open)).data;
  const ok = await call(status.GET, { path: `/api/status?id=${booking.id}&code=${booking.code}` });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.booking.status, "pending");
  assert.equal(ok.data.booking.phone, undefined);
  const lower = await call(status.GET, { path: `/api/status?id=${booking.id}&code=${booking.code.toLowerCase()}` });
  assert.equal(lower.status, 200); // codes aren't case-sensitive
  assert.equal((await call(status.GET, { path: `/api/status?id=${booking.id}&code=AAAAAA` })).status, 404);
  assert.equal((await call(status.GET, { path: `/api/status?id=${booking.id}` })).status, 404);
  assert.equal((await call(status.GET, { path: `/api/status?id=../settings&code=AAAAAA` })).status, 404);
  assert.equal((await call(status.GET, { path: `/api/status?id=zzzzzzzzzzzz&code=AAAAAA` })).status, 404);
});

// ---------- auth ----------

test("owner endpoints refuse visitors", async () => {
  assert.equal((await call(owner.GET, { path: "/api/owner" })).status, 401);
  assert.equal((await call(owner.POST, { method: "POST", body: { action: "settings", settings: {} } })).status, 401);
  assert.equal((await call(proof.GET, { path: "/api/proof?id=abcdefghijkl" })).status, 401);
  assert.equal((await call(auth.GET)).data.owner, false);
});

test("wrong password is refused (and slowed), right password sets a hardened cookie", async () => {
  const t0 = Date.now();
  const wrong = await call(auth.POST, { method: "POST", body: { password: "nope" } });
  assert.equal(wrong.status, 401);
  assert.ok(Date.now() - t0 >= 850, "wrong password should be delayed ~900ms");
  assert.equal(wrong.headers.get("set-cookie"), null);

  const right = await call(auth.POST, { method: "POST", body: { password: process.env.OWNER_PASSWORD } });
  assert.equal(right.status, 200);
  const cookie = right.headers.get("set-cookie");
  for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", `Max-Age=${30 * 24 * 3600}`]) assert.ok(cookie.includes(attr), attr);

  const pair = cookie.split(";")[0];
  assert.equal((await call(auth.GET, { cookie: pair })).data.owner, true);
  assert.equal((await call(owner.GET, { path: "/api/owner", cookie: pair })).status, 200);
  assert.equal((await call(auth.DELETE, { method: "DELETE", cookie: pair })).headers.get("set-cookie").includes("Max-Age=0"), true);
});

test("forged, tampered and expired cookies don't work", async () => {
  const good = await ownerCookie();
  const [name, value] = good.split("=");
  const [expiry, mac] = value.split(".");
  const flip = mac.slice(0, -1) + (mac.endsWith("0") ? "1" : "0");
  assert.equal((await call(owner.GET, { path: "/api/owner", cookie: `${name}=${expiry}.${flip}` })).status, 401);
  assert.equal((await call(owner.GET, { path: "/api/owner", cookie: `${name}=${Number(expiry) + 999999}.${mac}` })).status, 401); // changed expiry
  assert.equal((await call(owner.GET, { path: "/api/owner", cookie: `${name}=${expiry}` })).status, 401);
  assert.equal((await call(owner.GET, { path: "/api/owner", cookie: `${name}=garbage` })).status, 401);
  // a correctly signed but already-expired cookie
  const { createHmac } = await import("node:crypto");
  const past = Math.floor(Date.now() / 1000) - 10;
  const sig = createHmac("sha256", process.env.SESSION_SECRET).update(String(past)).digest("hex");
  assert.equal((await call(owner.GET, { path: "/api/owner", cookie: `${name}=${past}.${sig}` })).status, 401);
});

test("sign-in refuses to work when the server isn't configured", async () => {
  const saved = process.env.OWNER_PASSWORD;
  delete process.env.OWNER_PASSWORD;
  assert.equal((await call(auth.POST, { method: "POST", body: { password: "" } })).status, 503);
  process.env.OWNER_PASSWORD = saved;
});

// ---------- owner desk ----------

test("the owner can view receipts; receipts are images served with nosniff", async () => {
  const { date, open } = await bookable();
  const { booking } = (await bookAt(date, open, { receipt: receipt(4000) })).data;
  const none = (await bookAt(date, time.fromMins(time.toMins(open) + 120))).data.booking;
  const cookie = await ownerCookie();

  const r = await call(proof.GET, { path: `/api/proof?id=${booking.id}`, cookie });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/jpeg");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await r.res.arrayBuffer()), jpeg(4000));
  assert.equal((await call(proof.GET, { path: `/api/proof?id=${none.id}`, cookie })).status, 404);
  assert.equal((await call(proof.GET, { path: `/api/proof?id=../settings`, cookie })).status, 404);
});

test("owner lists bookings newest first with client details", async () => {
  const { date, open } = await bookable();
  await bookAt(date, open, { name: "First" });
  await new Promise((r) => setTimeout(r, 5));
  await bookAt(date, time.fromMins(time.toMins(open) + 90), { name: "Second" });
  const cookie = await ownerCookie();
  const r = await call(owner.GET, { path: "/api/owner", cookie });
  assert.deepEqual(r.data.bookings.map((b) => b.name), ["Second", "First"]);
  assert.equal(r.data.bookings[0].phone, "08137500330");
  assert.ok(r.data.settings.services.length > 0);
});

async function ownerPost(cookie, body) {
  return call(owner.POST, { method: "POST", cookie, body });
}

test("status flow: confirm → completed; illegal jumps are refused", async () => {
  const { date, open } = await bookable();
  const { booking } = (await bookAt(date, open)).data;
  const cookie = await ownerCookie();
  const set = (s) => ownerPost(cookie, { action: "status", id: booking.id, status: s });

  assert.equal((await set("done")).status, 409); // pending can't be completed
  assert.equal((await set("noshow")).status, 409);
  assert.equal((await set("confirmed")).status, 200);
  assert.equal((await call(status.GET, { path: `/api/status?id=${booking.id}&code=${booking.code}` })).data.booking.status, "confirmed");
  assert.equal((await set("pending")).status, 409);
  assert.equal((await set("rejected")).status, 409); // confirmed can't be rejected
  assert.equal((await set("done")).status, 200);
  assert.equal((await set("confirmed")).status, 409);
  // a completed booking still blocks its slot
  assert.equal((await bookAt(date, open)).status, 409);
});

test("rejecting a deposit releases the slot, which can then be rebooked", async () => {
  const { date, open } = await bookable();
  const { booking } = (await bookAt(date, open)).data;
  const cookie = await ownerCookie();
  assert.equal((await bookAt(date, open)).status, 409);
  assert.equal((await ownerPost(cookie, { action: "status", id: booking.id, status: "rejected" })).status, 200);
  assert.equal((await call(pub.GET)).data.taken.length, 0);
  assert.equal((await bookAt(date, open)).status, 200);
  // repeating the same release is harmless
  assert.equal((await ownerPost(cookie, { action: "status", id: booking.id, status: "rejected" })).status, 200);
  assert.equal((await call(pub.GET)).data.taken.length, 1);
});

test("a no-show releases the slot", async () => {
  const { date, open } = await bookable();
  const { booking } = (await bookAt(date, open)).data;
  const cookie = await ownerCookie();
  await ownerPost(cookie, { action: "status", id: booking.id, status: "confirmed" });
  assert.equal((await ownerPost(cookie, { action: "status", id: booking.id, status: "noshow" })).status, 200);
  assert.equal((await call(pub.GET)).data.taken.length, 0);
});

test("deleting removes the booking, its receipt and its slot", async () => {
  const { date, open } = await bookable();
  const { booking } = (await bookAt(date, open, { receipt: receipt(3000) })).data;
  const cookie = await ownerCookie();
  const r = await ownerPost(cookie, { action: "delete", id: booking.id });
  assert.equal(r.status, 200);
  assert.equal(__mock.paths("bookings/").length, 0);
  assert.equal(__mock.paths("proofs/").length, 0);
  assert.equal((await call(pub.GET)).data.taken.length, 0);
  assert.equal((await call(status.GET, { path: `/api/status?id=${booking.id}&code=${booking.code}` })).status, 404);
  assert.equal((await bookAt(date, open)).status, 200);
});

test("owner POST needs JSON, the same origin and a known action", async () => {
  const cookie = await ownerCookie();
  assert.equal((await ownerPost(cookie, { action: "explode" })).status, 400);
  assert.equal((await ownerPost(cookie, { action: "delete", id: "../x" })).status, 400);
  const cross = await call(owner.POST, { method: "POST", cookie, body: { action: "delete", id: "abcdefghijkl" }, headers: { origin: "https://evil.example", host: "localhost" } });
  assert.equal(cross.status, 403);
  const form = await call(owner.POST, { method: "POST", cookie, raw: "action=delete", headers: { "content-type": "text/plain" } });
  assert.equal(form.status, 415);
});

// ---------- settings ----------

test("saved settings reach a fresh visitor; bad settings are refused", async () => {
  const cookie = await ownerCookie();
  const current = (await call(owner.GET, { path: "/api/owner", cookie })).data.settings;
  const edited = structuredClone(current);
  edited.depositPct = 30;
  edited.bank.accountNumber = "0123456789";
  edited.hours.mon = { open: "10:00", close: "16:00" };
  edited.services[0] = { ...edited.services[0], name: "Soft Glam Plus", price: 27500 };
  edited.services.push({ name: "Brow Shape", category: "Makeup", price: 8000, mins: 30 });
  edited.confirmed = true;

  const saved = await ownerPost(cookie, { action: "settings", settings: edited });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.settings.confirmed, true);

  const visitor = (await call(pub.GET)).data.settings; // no cookie
  assert.equal(visitor.depositPct, 30);
  assert.equal(visitor.bank.accountNumber, "0123456789");
  assert.deepEqual(visitor.hours.mon, { open: "10:00", close: "16:00" });
  assert.equal(visitor.services[0].name, "Soft Glam Plus");
  assert.equal(visitor.services.length, current.services.length + 1);
  assert.ok(visitor.services.at(-1).id.startsWith("brow-shape-"));

  // new deposit % applies to new bookings, computed on the server
  const { date, open } = await bookable(1, visitor);
  const b = (await bookAt(date, open)).data.booking;
  assert.equal(b.deposit, 8250);

  const bad = (mutate) => {
    const s = structuredClone(edited);
    mutate(s);
    return ownerPost(cookie, { action: "settings", settings: s });
  };
  assert.equal((await bad((s) => { s.depositPct = 101; })).status, 400);
  assert.equal((await bad((s) => { s.services[0].price = 99.5; })).status, 400);
  assert.equal((await bad((s) => { s.services[0].mins = 45; })).status, 400);
  assert.equal((await bad((s) => { s.services = []; })).status, 400);
  assert.equal((await bad((s) => { s.hours.tue = { open: "10:00", close: "10:00" }; })).status, 400);
  assert.equal((await bad((s) => { s.hours = Object.fromEntries(Object.keys(s.hours).map((d) => [d, null])); })).status, 400);
  assert.equal((await bad((s) => { s.whatsapp = "12"; })).status, 400);
  assert.equal((await bad((s) => { s.instagram = "javascript:alert(1)"; })).status, 400);
  assert.equal((await bad((s) => { s.bank.name = ""; })).status, 400);
  assert.equal((await call(pub.GET)).data.settings.depositPct, 30); // refused saves changed nothing
});
