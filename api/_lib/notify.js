// Tells the studio by email when a booking comes in, through Resend.
// Inert until RESEND_API_KEY is set. Recipients: NOTIFY_EMAIL (comma separated) if set, else the studio
// email in Settings. A failure here is logged and swallowed: the booking is already saved, and nothing
// about email may ever make a booking fail.
const SEND_TIMEOUT_MS = 3500;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const naira = (n) => "₦" + Math.round(Number(n) || 0).toLocaleString("en-NG");

function when(date, time, tz) {
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

export function composeNewBooking(b, settings, origin) {
  const title = b.lookName ? `${b.serviceName}: ${b.lookName}${b.qty > 1 ? ` × ${b.qty}` : ""}` : b.serviceName;
  const at = when(b.date, b.time, settings.tz);
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
  const text = [`A new booking has come in.`, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", `Open the desk: ${deskUrl}`].join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;color:#0e0b0d">
    <p style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#8e0e4f;margin:0 0 6px">${esc(settings.name)}</p>
    <h1 style="font-size:22px;margin:0 0 16px;font-weight:600">New booking</h1>
    <table style="border-collapse:collapse;width:100%">${rows.map(([k, v]) => `<tr><td style="padding:8px 12px 8px 0;color:#6f6166;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:8px 0;border-bottom:1px solid #eee">${esc(v)}</td></tr>`).join("")}</table>
    <p style="margin:22px 0"><a href="${esc(deskUrl)}" style="background:#e0147c;color:#fff;padding:12px 22px;text-decoration:none;display:inline-block">Open the desk</a></p>
  </div>`;
  return { subject, text, html };
}

export async function notifyNewBooking({ booking, settings, origin }) {
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key || settings.notifyNewBookings === false) return { sent: false, reason: "off" };
    const to = recipients(settings);
    if (!to.length) return { sent: false, reason: "no recipient" };
    const { subject, text, html } = composeNewBooking(booking, settings, origin);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.NOTIFY_FROM || `${settings.name} <onboarding@resend.dev>`, to, subject, text, html }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`Booking email not sent: Resend answered ${res.status}`, (await res.text().catch(() => "")).slice(0, 300));
      return { sent: false, reason: `resend ${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error("Booking email not sent:", err?.name === "TimeoutError" ? "timed out" : err?.message);
    return { sent: false, reason: "error" };
  }
}
