// Email to the studio through Resend: the new-booking alert and the 48-hour appointment reminder.
// Inert until RESEND_API_KEY is set. Recipients: NOTIFY_EMAIL (comma separated) if set, else the studio
// email in Settings. A failure here is logged and reported, never thrown: nothing about email may ever
// make a booking fail.
const SEND_TIMEOUT_MS = 3500;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const naira = (n) => "₦" + Math.round(Number(n) || 0).toLocaleString("en-NG");

function when(date, time) {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  const [hh, mm] = time.split(":").map(Number);
  const clock = `${hh % 12 || 12}:${String(mm).padStart(2, "0")} ${hh >= 12 ? "pm" : "am"}`;
  return `${day}, ${clock}`;
}

function clockIn(epochMs, tz) {
  return new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }).format(new Date(epochMs)).replace(/\s?([ap])m/i, (_, a) => ` ${a.toLowerCase()}m`);
}

export function recipients(settings) {
  const raw = process.env.NOTIFY_EMAIL || settings.email || "";
  return raw.split(",").map((e) => e.trim()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}

export const senderFor = (settings) => process.env.NOTIFY_FROM || `${settings.name} <onboarding@resend.dev>`;
export const emailConfigured = (settings) => !!process.env.RESEND_API_KEY && recipients(settings).length > 0;

// One place that talks to Resend. Never throws. `retryable` is true for hiccups worth trying again
// (no answer, 429, 5xx) and false for answers that will not change (bad request, refused recipient).
export async function resend(path, { method = "POST", body, idempotencyKey } = {}) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, off: true, status: 0, retryable: false, error: "RESEND_API_KEY is not set" };
  // A real timer (not AbortSignal.timeout) so the request is always cut off, and cleared once it answers.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException("timed out", "TimeoutError")), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.resend.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const raw = await res.text().catch(() => "");
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { /* not json */ }
    if (res.ok) return { ok: true, status: res.status, data };
    const detail = (data?.message || raw).slice(0, 300);
    return { ok: false, status: res.status, data, error: `Resend answered ${res.status}${detail ? `: ${detail}` : ""}`, retryable: res.status === 429 || res.status === 408 || res.status >= 500 };
  } catch (err) {
    return { ok: false, status: 0, error: err?.name === "TimeoutError" ? "Resend did not answer in time" : `could not reach Resend (${err?.message})`, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

function details(b, settings) {
  const title = b.lookName ? `${b.serviceName}: ${b.lookName}${b.qty > 1 ? ` × ${b.qty}` : ""}` : b.serviceName;
  const at = when(b.date, b.time);
  return { title, at };
}

export function composeNewBooking(b, settings, origin) {
  const { title, at } = details(b, settings);
  const full = b.payment === "full";
  const deskUrl = `${origin}/#owner`;
  const status = b.hasReceipt
    ? "Receipt uploaded. Open the desk to view it and confirm."
    : b.holdUntil
      ? `No receipt yet. The slot is held until ${clockIn(b.holdUntil, settings.tz)} (Lagos time).`
      : "No receipt yet.";
  const rows = [
    ["Client", `${b.name} (${b.phone})`],
    ["Booking", title],
    ["When", `${at} (Lagos time), ${Math.round(b.mins)} minutes`],
    ["Total", naira(b.price)],
    [full ? "Paying now" : "Deposit now", full ? `${naira(b.deposit)} in full` : `${naira(b.deposit)}, balance ${naira(b.balance)} at the studio`],
    ["Receipt", status],
    ["Booking code", b.code],
    ...(b.note ? [["Note", b.note]] : []),
  ];
  const subject = `New booking: ${title}, ${at} · ${b.name}`.slice(0, 200);
  return { subject, ...layout("New booking", "A new booking has come in.", rows, deskUrl, settings) };
}

// The reminder is written when it is scheduled and read 48 hours later, so it only says things that
// stay true: who, what, when, what is still to be collected, and where to look for the live status.
export function composeReminder(b, settings, origin) {
  const { title, at } = details(b, settings);
  const deskUrl = origin ? `${origin}/#owner` : "";
  const rows = [
    ["Client", `${b.name} (${b.phone})`],
    ["Booking", title],
    ["When", `${at} (Lagos time), ${Math.round(b.mins)} minutes`],
    ["Total", naira(b.price)],
    ["To collect at the studio", b.balance > 0 ? naira(b.balance) : "Nothing, paid in full"],
    ["Booking code", b.code],
    ...(b.note ? [["Note", b.note]] : []),
  ];
  const subject = `Reminder: ${title}, ${at} · ${b.name}`.slice(0, 200);
  return { subject, ...layout("Appointment in 48 hours", "This appointment starts in 48 hours. Open the desk for the booking's latest status.", rows, deskUrl, settings) };
}

function layout(heading, intro, rows, deskUrl, settings) {
  const text = [intro, "", ...rows.map(([k, v]) => `${k}: ${v}`), ...(deskUrl ? ["", `Open the desk: ${deskUrl}`] : [])].join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;color:#0e0b0d">
    <p style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#8e0e4f;margin:0 0 6px">${esc(settings.name)}</p>
    <h1 style="font-size:22px;margin:0 0 8px;font-weight:600">${esc(heading)}</h1>
    <p style="margin:0 0 16px;color:#6f6166">${esc(intro)}</p>
    <table style="border-collapse:collapse;width:100%">${rows.map(([k, v]) => `<tr><td style="padding:8px 12px 8px 0;color:#6f6166;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:8px 0;border-bottom:1px solid #eee">${esc(v)}</td></tr>`).join("")}</table>
    ${deskUrl ? `<p style="margin:22px 0"><a href="${esc(deskUrl)}" style="background:#e0147c;color:#fff;padding:12px 22px;text-decoration:none;display:inline-block">Open the desk</a></p>` : ""}
  </div>`;
  return { text, html };
}

export async function notifyNewBooking({ booking, settings, origin }) {
  if (!process.env.RESEND_API_KEY || settings.notifyNewBookings === false) return { sent: false, reason: "off" };
  const to = recipients(settings);
  if (!to.length) return { sent: false, reason: "no recipient" };
  const { subject, text, html } = composeNewBooking(booking, settings, origin);
  const res = await resend("/emails", { body: { from: senderFor(settings), to, subject, text, html } });
  if (!res.ok) {
    console.error(`Booking email not sent: ${res.error}`);
    return { sent: false, reason: res.error };
  }
  return { sent: true };
}
