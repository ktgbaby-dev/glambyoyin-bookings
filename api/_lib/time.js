// Studio-time helpers. Everything is computed in the studio time zone
// (settings.tz, Africa/Lagos) with Intl, never the server's own zone.

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const fmtCache = new Map();
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(
      tz,
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
    );
  }
  return fmtCache.get(tz);
}

export function partsInTz(epochMs, tz) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(epochMs))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second };
}

const pad = (n) => String(n).padStart(2, "0");

export function dateInTz(epochMs, tz) {
  const p = partsInTz(epochMs, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function isValidDate(dateStr) {
  if (!DATE_RE.test(dateStr)) return false;
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function daysBetween(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

export function weekdayKey(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export const toMins = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
export const fromMins = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

// Offset of tz from UTC (minutes) at a given instant.
function offsetMinutes(tz, epochMs) {
  const p = partsInTz(epochMs, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60000);
}

// Epoch ms for a wall-clock date + time in tz (two passes handle DST edges).
export function zonedToEpoch(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let epoch = guess - offsetMinutes(tz, guess) * 60000;
  epoch = guess - offsetMinutes(tz, epoch) * 60000;
  return epoch;
}
