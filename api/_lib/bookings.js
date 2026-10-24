// Booking rules: validation, slot reservation (the double-booking guard), receipts.
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { HttpError, sleep } from "./http.js";
import { readJson, writeJson } from "./store.js";
import { canPayInFull, depositFor } from "./settings.js";
import {
  TIME_RE, dateInTz, daysBetween, isValidDate, toMins, weekdayKey, zonedToEpoch,
} from "./time.js";

export const DAYS_AHEAD = 21; // today + the next 20
export const NOTICE_MS = 2 * 60 * 60 * 1000;
export const SLOT_STEP = 30;
export const MAX_RECEIPT_B64 = 420_000; // ~315KB of image
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const RESERVE_ATTEMPTS = 5;

// Time-prefixed so listing bookings/ in name order is creation order.
export const newId = () => Date.now().toString(36) + randomBytes(8).toString("base64url").slice(0, 10);
export const newCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");

export function codeMatches(a, b) {
  const x = Buffer.from(String(a || "").toUpperCase().trim());
  const y = Buffer.from(String(b || "").toUpperCase().trim());
  return x.length === y.length && timingSafeEqual(x, y);
}

const bad = (message, field) => new HttpError(400, "invalid", message, field);

function cleanText(value, { min = 0, max, label, field }) {
  const s = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (s.length < min) throw bad(`Please add ${label}.`, field);
  if (s.length > max) throw bad(`${label[0].toUpperCase() + label.slice(1)} is too long.`, field);
  return s;
}

// Digits for WhatsApp links: 0813… (Nigeria) becomes 234813….
export function waNumber(phone) {
  const d = String(phone).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("0")) return "234" + d.slice(1);
  return d;
}

const MAGIC = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/webp": (b) => b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
};

export function cleanReceipt(receipt) {
  if (receipt == null) return null;
  const type = receipt.type;
  const data = typeof receipt.data === "string" ? receipt.data : "";
  if (!MAGIC[type] || !data) throw bad("That receipt isn't a JPEG, PNG or WebP image.", "receipt");
  if (data.length > MAX_RECEIPT_B64) throw bad("That receipt image is too large. Try a smaller photo.", "receipt");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw bad("That receipt couldn't be read.", "receipt");
  const buffer = Buffer.from(data, "base64");
  if (buffer.length < 16 || !MAGIC[type](buffer)) throw bad("That receipt isn't a valid image.", "receipt");
  return { type, buffer };
}

// A booking that still owes a payment and has no receipt only holds its slot for a while.
// Entries in days/<date>.json carry the same `holdUntil`; once it passes they stop counting.
export const holdLapsed = (holdUntil, nowMs) => !!holdUntil && holdUntil <= nowMs;
export const liveEntries = (entries, nowMs) => entries.filter((e) => !holdLapsed(e.holdUntil, nowMs));
export const isHoldExpired = (b, nowMs) => b.status === "pending" && holdLapsed(b.holdUntil, nowMs);

// How the client will pay: the deposit (the default), or the whole price when the studio offers that.
function cleanPayment(value, settings) {
  if (value == null || value === "" || value === "deposit") return "deposit";
  if (value === "full" && canPayInFull(settings)) return "full";
  throw bad("That payment option isn't available. Please choose again.", "payment");
}

// Validates a booking request against current settings and returns the
// record fields. Price and deposit always come from the server's settings.
export function validateBooking(input, settings, nowMs) {
  const service = settings.services.find((s) => s.id === input.serviceId);
  if (!service) throw bad("That service isn't available any more. Please choose again.", "service");

  // A service with looks is booked by choosing one look (and, for per-person
  // looks, how many people). Price and minutes always come from our settings.
  let item = service;
  let lookFields = {};
  if (service.looks?.length) {
    const look = service.looks.find((l) => l.id === input.lookId);
    if (!look) throw bad("Please choose your look.", "look");
    let qty = 1;
    if (look.perPerson) {
      qty = Number(input.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > look.maxQty) {
        throw bad(`Please choose between 1 and ${look.maxQty} people.`, "look");
      }
    }
    item = { price: look.price * qty, mins: look.mins * qty };
    lookFields = { lookId: look.id, lookName: look.name, qty, unitPrice: look.price };
  }

  const date = String(input.date || "");
  const today = dateInTz(nowMs, settings.tz);
  if (!isValidDate(date)) throw bad("Please choose a day.", "date");
  const offset = daysBetween(today, date);
  if (offset < 0 || offset >= DAYS_AHEAD) throw bad("Please choose a day in the next three weeks.", "date");

  const hours = settings.hours[weekdayKey(date)];
  if (!hours) throw bad("We're closed that day. Please choose another.", "date");

  const time = String(input.time || "");
  if (!TIME_RE.test(time) || toMins(time) % SLOT_STEP !== 0) throw bad("Please choose a time.", "time");
  const start = toMins(time);
  if (start < toMins(hours.open) || start + item.mins > toMins(hours.close)) {
    throw bad("That time falls outside our opening hours.", "time");
  }
  if (zonedToEpoch(date, time, settings.tz) < nowMs + NOTICE_MS) {
    throw bad("Please choose a time at least 2 hours from now.", "time");
  }

  const name = cleanText(input.name, { min: 2, max: 80, label: "your name", field: "name" });
  const phone = cleanText(input.phone, { max: 24, label: "your WhatsApp number", field: "phone" });
  if (!/^[\d+\-() ]+$/.test(phone) || phone.replace(/\D/g, "").length < 10 || phone.replace(/\D/g, "").length > 15) {
    throw bad("Please enter a WhatsApp number with at least 10 digits.", "phone");
  }
  const payer = cleanText(input.payer, { min: 2, max: 80, label: "the name on the sending account", field: "payer" });
  const note = cleanText(input.note ?? "", { max: 300, label: "your note", field: "note" });
  const receipt = cleanReceipt(input.receipt);

  // `deposit` is what the client pays now: the deposit, or the whole price when they pay in full.
  const payment = cleanPayment(input.payment, settings);
  const deposit = payment === "full" ? item.price : depositFor(item.price, settings.depositPct);
  // No receipt yet and something to pay: hold the slot for a while, never past the start of the appointment.
  const holdUntil = deposit > 0 && !receipt && settings.holdHours > 0
    ? Math.min(nowMs + settings.holdHours * 3_600_000, zonedToEpoch(date, time, settings.tz))
    : null;
  return {
    receipt,
    fields: {
      serviceId: service.id,
      serviceName: service.name,
      category: service.category,
      ...lookFields,
      mins: item.mins,
      price: item.price,
      payment,
      depositPct: payment === "full" ? 100 : settings.depositPct,
      deposit,
      balance: item.price - deposit,
      ...(holdUntil ? { holdUntil } : {}),
      date,
      time,
      name,
      phone,
      phoneWa: waNumber(phone),
      payer,
      note,
    },
  };
}

// ---- availability: days/YYYY-MM-DD.json is the single source of truth ----

const dayPath = (date) => `days/${date}.json`;
const overlaps = (aStart, aMins, bStart, bMins) => aStart < bStart + bMins && bStart < aStart + aMins;

// The write failed. Decide whether someone else changed the file under us
// (a collision: retry) or it's a real error (rethrow).
async function lostRace(date, seen) {
  const now = await readJson(dayPath(date));
  return seen ? now?.etag !== seen.etag : !!now;
}

// Idempotent for the same booking `id`: reserving again replaces its entry (this is how a confirmed
// booking drops its hold). Entries whose hold has lapsed no longer count and are cleared on the way.
export async function reserveSlot({ date, time, mins, id, holdUntil = null, nowMs = Date.now() }) {
  for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
    const cur = await readJson(dayPath(date));
    const entries = liveEntries((cur?.data.entries ?? []).filter((e) => e.id !== id), nowMs);
    const start = toMins(time);
    if (entries.some((e) => overlaps(start, mins, toMins(e.time), e.mins))) {
      throw new HttpError(409, "slot_taken", "Sorry, that time was just taken. Please pick another.", "time");
    }
    try {
      // Existing file: only write if nobody changed it (ifMatch). New day: create-only.
      const entry = { id, time, mins, ...(holdUntil ? { holdUntil } : {}) };
      await writeJson(dayPath(date), { entries: [...entries, entry] }, cur ? { ifMatch: cur.etag } : "create");
      return;
    } catch (err) {
      if (!(await lostRace(date, cur))) throw err;
      await sleep(40 + Math.random() * 160);
    }
  }
  throw new HttpError(409, "slot_busy", "Lots of people are booking right now. Please try again in a moment.");
}

// Idempotent: removes the entry for booking `id` if it is there.
export async function releaseSlot(date, id) {
  for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
    const cur = await readJson(dayPath(date));
    if (!cur || !cur.data.entries.some((e) => e.id === id)) return;
    try {
      await writeJson(dayPath(date), { entries: cur.data.entries.filter((e) => e.id !== id) }, { ifMatch: cur.etag });
      return;
    } catch (err) {
      if (!(await lostRace(date, cur))) throw err;
      await sleep(40 + Math.random() * 160);
    }
  }
  throw new HttpError(503, "release_failed", "Couldn't free that slot just now. Please try again.");
}

// What a client may see about their own booking.
export function clientView(b, nowMs = Date.now()) {
  return {
    id: b.id,
    code: b.code,
    status: b.status,
    serviceName: b.serviceName,
    lookName: b.lookName ?? null,
    qty: b.qty ?? null,
    unitPrice: b.unitPrice ?? null,
    category: b.category,
    mins: b.mins,
    price: b.price,
    payment: b.payment ?? "deposit",
    deposit: b.deposit,
    balance: b.balance,
    date: b.date,
    time: b.time,
    name: b.name,
    hasReceipt: !!b.hasReceipt,
    holdUntil: b.holdUntil ?? null,
    holdExpired: isHoldExpired(b, nowMs),
    createdAt: b.createdAt,
  };
}
