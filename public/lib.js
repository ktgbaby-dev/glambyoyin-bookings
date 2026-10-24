// Shared browser helpers. The studio-time maths mirrors api/_lib/time.js:
// everything is computed in the studio zone (settings.tz), never the device's.

export const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const MONTH_SHORT = MONTH_LONG.map((m) => m.slice(0, 3));

// ---- text ----
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export const naira = (n) => "₦" + Math.round(Number(n) || 0).toLocaleString("en-NG");

// "Bridal Glam: Aso-Ebi / Bridesmaids × 3": the service, then the look and how many people.
export const bookingTitle = ({ serviceName, lookName, qty }) =>
  lookName ? `${serviceName}: ${lookName}${qty > 1 ? ` × ${qty}` : ""}` : serviceName;

export function duration(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

// ---- dates: strings are YYYY-MM-DD / HH:MM in studio time ----
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utcDate = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
export const addDays = (s, n) => ymd(new Date(utcDate(s).getTime() + n * 86400000));
export const dow = (s) => utcDate(s).getUTCDay();
export const weekdayKey = (s) => WEEKDAYS[dow(s)];
export const toMins = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
export const fromMins = (n) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;

export function fmtDate(s, { short = false } = {}) {
  const d = utcDate(s);
  const day = d.getUTCDate();
  const month = (short ? MONTH_SHORT : MONTH_LONG)[d.getUTCMonth()];
  return `${(short ? DOW_SHORT : DOW_LONG)[d.getUTCDay()]} ${day} ${month}`;
}

export function fmtTime(t) {
  const [h24, m] = t.split(":").map(Number);
  const h = h24 % 24; // "24:00" is midnight at the end of the day
  const suffix = h >= 12 ? "pm" : "am";
  return `${h % 12 || 12}:${pad(m)} ${suffix}`;
}

// A day open from midnight to midnight.
export const isAllDay = (h) => !!h && h.open === "00:00" && h.close === "24:00";
export const fmtRange = (a, b) => (a === "00:00" && b === "24:00" ? "Open 24 hours" : `${fmtTime(a)} – ${fmtTime(b)}`);

// ---- studio clock ----
const fmts = new Map();
function parts(epochMs, tz) {
  if (!fmts.has(tz)) {
    fmts.set(tz, new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }));
  }
  const p = {};
  for (const { type, value } of fmts.get(tz).formatToParts(new Date(epochMs))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second };
}

export function studioDate(epochMs, tz) {
  const p = parts(epochMs, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function studioMinutes(epochMs, tz) {
  const p = parts(epochMs, tz);
  return p.hh * 60 + p.mm;
}

function offsetMinutes(tz, epochMs) {
  const p = parts(epochMs, tz);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(epochMs / 1000) * 1000) / 60000);
}

export function zonedToEpoch(date, time, tz) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let epoch = guess - offsetMinutes(tz, guess) * 60000;
  epoch = guess - offsetMinutes(tz, epoch) * 60000;
  return epoch;
}

// ---- API ----
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || "Something went wrong. Please try again.");
    this.status = status;
    this.code = body?.error || "error";
    this.field = body?.field;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    const err = new ApiError(0, { error: "network", message: "We couldn't reach the server. Check your connection and try again." });
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ---- status wording ----
export const STATUS = {
  pending: { label: "Awaiting confirmation", pill: "pill-pending" },
  confirmed: { label: "Confirmed", pill: "pill-confirmed" },
  rejected: { label: "Deposit not received", pill: "pill-rejected" },
  done: { label: "Completed", pill: "pill-done" },
  noshow: { label: "Missed", pill: "pill-noshow" },
};

export const pill = (status) => {
  const s = STATUS[status] || STATUS.pending;
  return `<span class="pill ${s.pill}">${esc(s.label)}</span>`;
};

// ---- misc ----
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}

export function wireCopyButtons(root) {
  root.querySelectorAll("[data-copy]").forEach((btn) => {
    const label = btn.textContent;
    let timer;
    btn.addEventListener("click", async () => {
      const ok = await copyText(btn.dataset.copy);
      clearTimeout(timer);
      btn.textContent = ok ? "Copied" : "Copy failed";
      btn.classList.toggle("copied", ok);
      timer = setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove("copied");
      }, 1600);
    });
  });
}
