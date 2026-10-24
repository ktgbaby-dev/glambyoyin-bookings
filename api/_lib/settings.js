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
  allowFullPayment: true, // clients may pay the whole price up front instead of the deposit
  bank: { name: "Ecobank", accountNumber: "0250147305", accountName: "Obaseki Oyindamola" },
  policy:
    "Payment validates your booking. Once a payment has been made, your booking is final and refunds are not allowed. " +
    "If you pay a deposit, it holds your slot and comes off your total, and the balance is paid at the studio. " +
    "Please arrive on time with a clean face.",
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
    // A service with `looks` is booked by choosing one look. Its own price and
    // minutes are the lowest of its looks ("from"), worked out by cleanServices.
    // A look with `includes` is a bundle: its minutes are the sum of the looks it
    // includes. A `perPerson` look is priced and timed per person.
    {
      id: "bridal-glam", name: "Bridal Glam", category: "Makeup", price: 25000, mins: 60,
      lookTitle: "Choose Your Bridal Look",
      looks: [
        { id: "introduction", name: "Introduction", price: 50000, mins: 120 },
        { id: "registry", name: "Registry", price: 50000, mins: 120 },
        { id: "traditional", name: "Traditional Wedding", price: 80000, mins: 150 },
        { id: "white-wedding", name: "White / Church Wedding", price: 80000, mins: 150 },
        { id: "aso-ebi", name: "Aso-Ebi / Bridesmaids", price: 25000, mins: 60, perPerson: true, maxQty: 8 },
        { id: "wedding-combo", name: "Wedding Combo: Traditional + White/Church Wedding", price: 150000, mins: 300, includes: ["traditional", "white-wedding"] },
      ],
    },
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
    // "24:00" is allowed as a closing time only: it means open until the end of the day.
    const closeOk = TIME_RE.test(h.close || "") || h.close === "24:00";
    if (!TIME_RE.test(h.open || "") || !closeOk || toMins(h.close) - toMins(h.open) < 30) {
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

const MAX_LOOKS = 12;
const MAX_LOOK_QTY = 20;
const MAX_MINS = 480;

const validMins = (n) => Number.isInteger(n) && n >= 30 && n <= MAX_MINS && n % 30 === 0;
const validPrice = (n) => Number.isInteger(n) && n >= 0 && n <= 10_000_000;

// The looks of one service (see DEFAULT_SETTINGS). Bundles list the ids of the
// single looks they include; their minutes are the sum of those, so they can't drift.
function cleanLooks(input, serviceName, longestDay) {
  if (input.length > MAX_LOOKS) throw new HttpError(400, "invalid_settings", `${serviceName} has more than ${MAX_LOOKS} looks.`);
  const seen = new Set();
  const looks = input.map((raw) => {
    const name = text(raw?.name, 60, { required: true, label: `Each look name in ${serviceName}` });
    const price = Number(raw?.price);
    if (!validPrice(price)) throw new HttpError(400, "invalid_settings", `Enter a whole-naira price for ${name}.`);
    let id = typeof raw?.id === "string" && /^[a-z0-9-]{2,48}$/.test(raw.id) ? raw.id : slug(name);
    while (seen.has(id)) id = slug(name);
    seen.add(id);
    return { id, name, price, raw };
  });

  const byId = new Map(looks.map((l) => [l.id, l]));
  const out = [];
  for (const look of looks) {
    const { raw } = look;
    if (Array.isArray(raw.includes) && raw.includes.length) {
      const parts = raw.includes.map((pid) => byId.get(pid));
      if (parts.length < 2 || parts.some((p) => !p || p.raw.includes?.length || p.raw.perPerson) || new Set(raw.includes).size !== parts.length) {
        throw new HttpError(400, "invalid_settings", `${look.name} can only bundle two or more single, per-booking looks from ${serviceName}.`);
      }
      const mins = parts.reduce((sum, p) => sum + Number(p.raw.mins), 0);
      if (!parts.every((p) => validMins(Number(p.raw.mins))) || mins > MAX_MINS || (longestDay && mins > longestDay)) {
        throw new HttpError(400, "invalid_settings", `${look.name} is longer than any opening day, so it could never be booked.`);
      }
      out.push({ id: look.id, name: look.name, price: look.price, mins, includes: [...raw.includes] });
      continue;
    }
    const mins = Number(raw.mins);
    if (!validMins(mins)) {
      throw new HttpError(400, "invalid_settings", `${look.name} needs a length in 30-minute steps (30 min to 8 hours).`);
    }
    if (raw.perPerson === true) {
      const maxQty = raw.maxQty == null ? 8 : Number(raw.maxQty);
      if (!Number.isInteger(maxQty) || maxQty < 2 || maxQty > MAX_LOOK_QTY) {
        throw new HttpError(400, "invalid_settings", `${look.name}: the most people per booking should be between 2 and ${MAX_LOOK_QTY}.`);
      }
      if (mins * maxQty > MAX_MINS) {
        throw new HttpError(400, "invalid_settings", `${look.name}: ${maxQty} people at ${mins} minutes each is more than 8 hours. Lower the number of people.`);
      }
      if (longestDay && mins > longestDay) {
        throw new HttpError(400, "invalid_settings", `${look.name} is longer than any opening day, so it could never be booked.`);
      }
      out.push({ id: look.id, name: look.name, price: look.price, mins, perPerson: true, maxQty });
      continue;
    }
    if (longestDay && mins > longestDay) {
      throw new HttpError(400, "invalid_settings", `${look.name} is longer than any opening day, so it could never be booked.`);
    }
    out.push({ id: look.id, name: look.name, price: look.price, mins });
  }
  return out;
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
    let id = typeof svc?.id === "string" && /^[a-z0-9-]{2,48}$/.test(svc.id) ? svc.id : slug(name);
    while (seen.has(id)) id = slug(name);
    seen.add(id);

    // A service with looks is "from" its cheapest and shortest look.
    if (Array.isArray(svc?.looks) && svc.looks.length) {
      const looks = cleanLooks(svc.looks, name, longestDay);
      const lookTitle = text(svc.lookTitle, 60, { label: "The look heading" }) || "Choose your look";
      return {
        id, name, category,
        price: Math.min(...looks.map((l) => l.price)),
        mins: Math.min(...looks.map((l) => l.mins)),
        lookTitle,
        looks,
      };
    }

    const price = Number(svc?.price);
    if (!validPrice(price)) {
      throw new HttpError(400, "invalid_settings", `Enter a whole-naira price for ${name}.`);
    }
    const mins = Number(svc?.mins);
    if (!validMins(mins)) {
      throw new HttpError(400, "invalid_settings", `${name} needs a length in 30-minute steps (30 min to 8 hours).`);
    }
    if (longestDay && mins > longestDay) {
      throw new HttpError(400, "invalid_settings", `${name} is longer than any opening day, so it could never be booked.`);
    }
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
    allowFullPayment: input.allowFullPayment !== false,
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

// Paying in full is only a real choice when the deposit is neither nothing nor everything.
export const canPayInFull = (s) => s.allowFullPayment !== false && s.depositPct > 0 && s.depositPct < 100;

export function depositFor(price, pct) {
  return Math.round((price * pct) / 100);
}
