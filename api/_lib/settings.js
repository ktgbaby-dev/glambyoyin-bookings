// Studio settings: defaults in code, overrides in settings.json.
import { randomBytes } from "node:crypto";
import { HttpError } from "./http.js";
import { readJson, writeJson } from "./store.js";
import { TIME_RE, WEEKDAYS, toMins } from "./time.js";

export const CATEGORIES = ["Makeup", "Lashes"];

// Starting point. Services, prices, durations, opening hours and the deposit %
// are placeholders until confirmed with Oyin. `confirmed` stays false (and the
// owner desk shows a reminder) until she ticks it in Settings.
export const DEFAULT_SETTINGS = {
  name: "GLAM BY OYIN",
  area: "Lagos",
  tagline: "Beauty, taken seriously.",
  tz: "Africa/Lagos",
  whatsapp: "2348137500330",
  email: "oyindamolaobaseki91@gmail.com",
  instagram: "https://www.instagram.com/glambyoyin_/",
  depositPct: 50,
  bank: { name: "Ecobank", accountNumber: "0250147305", accountName: "Obaseki Oyindamola" },
  policy:
    "Your deposit holds your slot and comes off your total on the day; the balance is paid at the studio. " +
    "Please arrive on time with a clean face. To move or cancel a booking, message us on WhatsApp as early as you can.",
  hours: {
    sun: { open: "12:00", close: "17:00" },
    mon: null,
    tue: { open: "09:00", close: "18:00" },
    wed: { open: "09:00", close: "18:00" },
    thu: { open: "09:00", close: "18:00" },
    fri: { open: "09:00", close: "18:00" },
    sat: { open: "09:00", close: "18:00" },
  },
  services: [
    { id: "soft-glam", name: "Soft Glam", category: "Makeup", price: 25000, mins: 90 },
    { id: "full-glam", name: "Full Glam", category: "Makeup", price: 35000, mins: 120 },
    { id: "bridal-glam", name: "Bridal Glam", category: "Makeup", price: 80000, mins: 150 },
    { id: "classic-lashes", name: "Classic Lash Extensions", category: "Lashes", price: 15000, mins: 90 },
    { id: "hybrid-lashes", name: "Hybrid Lash Extensions", category: "Lashes", price: 20000, mins: 120 },
    { id: "volume-lashes", name: "Volume Lash Extensions", category: "Lashes", price: 25000, mins: 150 },
    { id: "lash-refill", name: "Lash Refill", category: "Lashes", price: 10000, mins: 60 },
  ],
  confirmed: false,
  updatedAt: null,
};

const SETTINGS_PATH = "settings.json";

function text(value, max, { required = false, label = "This field" } = {}) {
  const s = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (required && !s) throw new HttpError(400, "invalid_settings", `${label} can't be empty.`);
  if (s.length > max) throw new HttpError(400, "invalid_settings", `${label} is too long (max ${max} characters).`);
  return s;
}

function digits(value, min, max, label) {
  const s = String(value ?? "").replace(/\D/g, "");
  if (s.length < min || s.length > max) {
    throw new HttpError(400, "invalid_settings", `${label} should be ${min}–${max} digits.`);
  }
  return s;
}

function validTz(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function cleanHours(input) {
  const out = {};
  for (const day of WEEKDAYS) {
    const h = input?.[day];
    if (!h) {
      out[day] = null;
      continue;
    }
    if (!TIME_RE.test(h.open || "") || !TIME_RE.test(h.close || "") || toMins(h.close) - toMins(h.open) < 30) {
      throw new HttpError(400, "invalid_settings", `Check the opening hours for ${day[0].toUpperCase() + day.slice(1)}: closing must be at least 30 minutes after opening.`);
    }
    out[day] = { open: h.open, close: h.close };
  }
  return out;
}

function slug(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "service";
  return `${base}-${randomBytes(2).toString("hex")}`;
}

function cleanServices(input, hours) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new HttpError(400, "invalid_settings", "Add at least one service.");
  }
  if (input.length > 40) throw new HttpError(400, "invalid_settings", "That's more than 40 services.");
  const longestDay = Math.max(0, ...Object.values(hours).filter(Boolean).map((h) => toMins(h.close) - toMins(h.open)));
  const seen = new Set();
  return input.map((svc) => {
    const name = text(svc?.name, 60, { required: true, label: "Each service name" });
    const category = CATEGORIES.includes(svc?.category) ? svc.category : null;
    if (!category) throw new HttpError(400, "invalid_settings", `Pick a category for ${name}.`);
    const price = Number(svc?.price);
    if (!Number.isInteger(price) || price < 0 || price > 10_000_000) {
      throw new HttpError(400, "invalid_settings", `Enter a whole-naira price for ${name}.`);
    }
    const mins = Number(svc?.mins);
    if (!Number.isInteger(mins) || mins < 30 || mins > 480 || mins % 30 !== 0) {
      throw new HttpError(400, "invalid_settings", `${name} needs a length in 30-minute steps (30 min to 8 hours).`);
    }
    if (longestDay && mins > longestDay) {
      throw new HttpError(400, "invalid_settings", `${name} is longer than any opening day, so it could never be booked.`);
    }
    let id = typeof svc?.id === "string" && /^[a-z0-9-]{2,48}$/.test(svc.id) ? svc.id : slug(name);
    while (seen.has(id)) id = slug(name);
    seen.add(id);
    return { id, name, category, price, mins };
  });
}

// strict: owner input, throws a clear 400 on the first problem.
export function cleanSettings(input) {
  const hours = cleanHours(input.hours);
  if (!Object.values(hours).some(Boolean)) {
    throw new HttpError(400, "invalid_settings", "Open at least one day a week.");
  }
  const depositPct = Number(input.depositPct);
  if (!Number.isInteger(depositPct) || depositPct < 0 || depositPct > 100) {
    throw new HttpError(400, "invalid_settings", "Deposit should be a whole percentage between 0 and 100.");
  }
  const email = text(input.email, 120, { label: "Email" });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "invalid_settings", "That email address doesn't look right.");
  }
  const instagram = text(input.instagram, 200, { label: "Instagram link" });
  if (instagram && !/^https:\/\/(www\.)?instagram\.com\/[A-Za-z0-9._]+\/?$/.test(instagram)) {
    throw new HttpError(400, "invalid_settings", "Use the full Instagram link, like https://www.instagram.com/yourname/");
  }
  return {
    name: text(input.name, 60, { required: true, label: "Studio name" }),
    area: text(input.area, 60, { label: "Area" }),
    tagline: text(input.tagline, 120, { label: "Tagline" }),
    tz: validTz(input.tz) ? input.tz : DEFAULT_SETTINGS.tz,
    whatsapp: digits(input.whatsapp, 10, 15, "WhatsApp number"),
    email,
    instagram,
    depositPct,
    bank: {
      name: text(input.bank?.name, 60, { required: true, label: "Bank name" }),
      accountNumber: digits(input.bank?.accountNumber, 6, 20, "Account number"),
      accountName: text(input.bank?.accountName, 80, { required: true, label: "Account name" }),
    },
    policy: text(input.policy, 1000, { label: "Booking policy" }),
    hours,
    services: cleanServices(input.services, hours),
    confirmed: input.confirmed === true,
    updatedAt: new Date().toISOString(),
  };
}

// lenient: stored data merged over defaults, so a bad stored value can never
// take the public page down; it just falls back to the default.
export async function loadSettings() {
  const stored = await readJson(SETTINGS_PATH);
  if (!stored) return structuredClone(DEFAULT_SETTINGS);
  const merged = { ...structuredClone(DEFAULT_SETTINGS), ...stored.data };
  try {
    return { ...cleanSettings(merged), updatedAt: stored.data.updatedAt ?? null };
  } catch (err) {
    console.error("Stored settings invalid, using defaults:", err.message);
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(input) {
  const clean = cleanSettings(input);
  await writeJson(SETTINGS_PATH, clean);
  return clean;
}

// What the public page may see (no internal flags).
export function publicSettings(s) {
  const { confirmed, updatedAt, ...rest } = s;
  return rest;
}

export function depositFor(price, pct) {
  return Math.round((price * pct) / 100);
}
