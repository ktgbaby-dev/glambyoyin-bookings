// GLAM BY OYIN bookings: client page.
import {
  ApiError, DOW_SHORT, MONTH_SHORT, addDays, api, bookingTitle, dow, duration, esc, fmtDate, fmtRange, fmtTime,
  fromMins, isAllDay, naira, pill, studioDate, studioMinutes, toMins, weekdayKey, wireCopyButtons, zonedToEpoch,
} from "./lib.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const LS_BOOKINGS = "gbo:bookings";
const LS_PROFILE = "gbo:profile";
const DAYS_AHEAD = 21;
const NOTICE_MS = 2 * 60 * 60 * 1000;
const STEP = 30;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  settings: null,
  taken: [],
  today: "",
  skew: 0,
  category: "all",
  service: null,
  payment: "deposit", // or "full": what the client pays now
  lookId: null, // for services booked by look (Bridal Glam)
  qty: 1, // people, for per-person looks
  date: null,
  time: null,
  step: 1,
  receipt: null, // { type, data, url, size }
  submitting: false,
  shown: null, // id of the booking currently shown as a ticket
};

const now = () => Date.now() + state.skew;
const store = {
  read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: fine */ }
  },
};

const depositFor = (price, pct) => Math.round((price * pct) / 100);
// Paying in full is only a real choice when the deposit is neither nothing nor everything.
const canPayInFull = (s) => s.allowFullPayment !== false && s.depositPct > 0 && s.depositPct < 100;
const waLink = (text) => `https://wa.me/${state.settings.whatsapp}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
const cityOf = (tz) => (tz.split("/").pop() || tz).replace(/_/g, " ");

function scrollToEl(el) {
  el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
}

/* ---------------- data ---------------- */

async function loadPublic() {
  const data = await api("/api/public");
  state.settings = data.settings;
  state.taken = data.taken;
  state.today = data.today;
  state.skew = data.now - Date.now();
}

/* ---------------- facts, services, info ---------------- */

function renderFacts() {
  const s = state.settings;
  const t = now();
  const date = studioDate(t, s.tz);
  const mins = studioMinutes(t, s.tz);
  const h = s.hours[weekdayKey(date)];
  const open = !!h && mins >= toMins(h.open) && mins < toMins(h.close);
  const today = h ? (isAllDay(h) ? "Open 24 hours today" : `Today ${fmtRange(h.open, h.close)}`) : "Closed today";
  const deposit = s.depositPct > 0 ? `${s.depositPct}% deposit holds your slot` : "Book online, pay at the studio";
  const items = [
    `<li><span class="label"><span class="open-dot ${open ? "is-open" : ""}"></span>${open ? "Open now" : "Closed now"}</span>${esc(today)}</li>`,
    s.area ? `<li><span class="label">Studio</span>${esc(s.area)}</li>` : "",
    `<li><span class="label">Deposit</span>${esc(deposit)}</li>`,
  ];
  const facts = $("#facts");
  facts.innerHTML = items.join("");
  facts.hidden = false;
}

function renderServices() {
  const s = state.settings;
  const cats = [...new Set(s.services.map((x) => x.category))];
  const chips = $("#chips");
  chips.hidden = cats.length < 2;
  chips.innerHTML = ["all", ...cats]
    .map((c) => `<button type="button" class="chip" data-cat="${esc(c)}" aria-pressed="${state.category === c}">${c === "all" ? "All" : esc(c)}</button>`)
    .join("");

  const groups = cats
    .filter((c) => state.category === "all" || state.category === c)
    .map((c) => {
      const rows = s.services
        .filter((x) => x.category === c)
        .map((x) => {
          const dep = depositFor(x.price, s.depositPct);
          const meta = hasLooks(x)
            ? "Choose your look next"
            : s.depositPct > 0 ? `${duration(x.mins)} · ${naira(dep)} deposit` : duration(x.mins);
          return `<div class="service-row">
            <span class="service-name">${esc(x.name)}</span>
            <span class="service-price">${hasLooks(x) ? "From " : ""}${naira(x.price)}</span>
            <span class="service-meta">${esc(meta)}</span>
            <button type="button" class="btn btn-outline btn-sm" data-service="${esc(x.id)}" aria-label="Book ${esc(x.name)}">Book</button>
          </div>`;
        })
        .join("");
      return `<div class="service-group"><h3>${esc(c)}</h3><div class="service-list">${rows}</div></div>`;
    })
    .join("");
  $("#services-list").innerHTML = groups || `<p class="status-line">No services are listed right now.</p>`;
}

function renderInfo() {
  const s = state.settings;
  const today = studioDate(now(), s.tz);
  const todayKey = weekdayKey(today);
  const order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const names = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
  $("#hours").innerHTML = order
    .map((k) => `<li class="${k === todayKey ? "is-today" : ""}"><span>${names[k]}</span><span>${s.hours[k] ? esc(fmtRange(s.hours[k].open, s.hours[k].close)) : "Closed"}</span></li>`)
    .join("");
  $("#policy").textContent = s.policy;
  const lines = [
    s.whatsapp && `<a href="${waLink()}" target="_blank" rel="noopener">WhatsApp</a>`,
    s.email && `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>`,
    s.instagram && `<a href="${esc(s.instagram)}" target="_blank" rel="noopener">Instagram</a>`,
  ].filter(Boolean);
  $("#contact-lines").innerHTML = lines.join("");
}

function renderAll() {
  renderFacts();
  renderServices();
  renderInfo();
  revealCheck(); // the facts row appears after load; reveal it without waiting for a scroll
}

/* ---------------- availability ---------------- */

function takenMap() {
  const map = new Map();
  for (const t of state.taken) {
    if (!map.has(t.date)) map.set(t.date, []);
    map.get(t.date).push([toMins(t.time), toMins(t.time) + t.mins]);
  }
  return map;
}

function slotsFor(date, service, tmap) {
  const h = state.settings.hours[weekdayKey(date)];
  if (!h) return [];
  const out = [];
  const tNow = now();
  for (let t = toMins(h.open); t + service.mins <= toMins(h.close); t += STEP) {
    const time = fromMins(t);
    const soon = zonedToEpoch(date, time, state.settings.tz) < tNow + NOTICE_MS;
    const busy = (tmap.get(date) || []).some(([a, b]) => t < b && a < t + service.mins);
    out.push({ time, free: !soon && !busy });
  }
  return out;
}

/* ---------------- booking flow ---------------- */

function startBooking(serviceId) {
  const service = state.settings.services.find((x) => x.id === serviceId);
  if (!service) return;
  state.service = service;
  state.lookId = null;
  state.qty = 1;
  state.payment = "deposit";
  state.date = null;
  state.time = null;
  clearReceipt();
  $("#book").hidden = false;
  $("#ticket-view").hidden = true;
  $("#flow").hidden = false;
  $("#tz-note").textContent = `All times are ${cityOf(state.settings.tz)} time. Pick a slot at least 2 hours from now.`;
  goStep(1, { focus: false });
  renderLooks();
  renderStep1();
  scrollToEl($("#book"));
  stepTitle(1).focus({ preventScroll: true });
}

// The heading to focus for a step; step 1 starts with the look picker when the service has looks.
function stepTitle(n) {
  return n === 1 && hasLooks(state.service) ? $("#look-title") : $(`#step-${n} .step-title`);
}

function goStep(n, { focus = true } = {}) {
  state.step = n;
  [1, 2, 3].forEach((i) => { $(`#step-${i}`).hidden = i !== n; });
  $$("#stepbar li").forEach((li, i) => {
    li.classList.toggle("is-done", i + 1 < n);
    li.classList.toggle("is-current", i + 1 === n);
    if (i + 1 === n) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  });
  if (n === 3) renderStep3();
  if (focus) stepTitle(n).focus({ preventScroll: true });
  if (focus) scrollToEl($("#book"));
}

function renderStep1() {
  const o = order();
  renderHeader();
  $("#when").hidden = !o; // a service with looks needs a look first: its length decides which times fit
  if (!o) {
    $("#s1-next").disabled = true;
    return;
  }
  const tmap = takenMap();
  const days = Array.from({ length: DAYS_AHEAD }, (_, i) => addDays(state.today, i)).map((date) => {
    const slots = slotsFor(date, o, tmap);
    return { date, closed: !state.settings.hours[weekdayKey(date)], free: slots.some((x) => x.free), slots };
  });

  const current = days.find((d) => d.date === state.date);
  if (!current || !current.free) {
    state.date = days.find((d) => d.free)?.date ?? null;
    state.time = null;
  }
  const chosen = days.find((d) => d.date === state.date);
  if (state.time && !chosen?.slots.some((x) => x.time === state.time && x.free)) state.time = null;

  $("#days").innerHTML = days
    .map((d) => {
      const [, m, dd] = d.date.split("-").map(Number);
      const why = d.closed ? ", closed" : !d.free ? ", fully booked" : "";
      return `<button type="button" class="day" data-date="${d.date}" aria-pressed="${d.date === state.date}"
        aria-label="${esc(fmtDate(d.date))}${why}" ${d.closed || !d.free ? "disabled" : ""}>
        <span class="dow">${DOW_SHORT[dow(d.date)]}</span><span class="num">${dd}</span><span class="mon">${MONTH_SHORT[m - 1]}</span></button>`;
    })
    .join("");

  const sel = $(".day[aria-pressed='true']");
  if (sel) {
    const box = $("#days");
    box.scrollLeft = sel.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft - box.clientWidth / 2 + sel.clientWidth / 2;
  }
  renderTimes(chosen);
}

function renderTimes(day) {
  const times = $("#times");
  const note = $("#times-note");
  note.innerHTML = "";
  if (!day) {
    times.innerHTML = "";
    note.innerHTML = `There are no free times in the next three weeks. <a href="${waLink()}" target="_blank" rel="noopener" style="text-decoration:underline">Message us on WhatsApp</a> and we'll find you a slot.`;
  } else {
    times.innerHTML = day.slots
      .map((s) => `<button type="button" class="time" data-time="${s.time}" aria-pressed="${s.time === state.time}"
        aria-label="${esc(fmtTime(s.time))}${s.free ? "" : ", unavailable"}" ${s.free ? "" : "disabled"}>${esc(fmtTime(s.time))}</button>`)
      .join("");
  }
  $("#s1-next").disabled = !(state.date && state.time);
}

function showTimesMessage(msg) {
  $("#times-note").textContent = msg;
}

/* ---- looks: services booked by choosing a look (Bridal Glam) ---- */

const hasLooks = (svc) => !!svc?.looks?.length;
const selectedLook = () => state.service?.looks?.find((l) => l.id === state.lookId) ?? null;
const includedLooks = (look) => (look.includes || []).map((id) => state.service.looks.find((l) => l.id === id)).filter(Boolean);
const wasPrice = (look) => includedLooks(look).reduce((n, l) => n + l.price, 0);
const savingOf = (look) => Math.max(0, wasPrice(look) - look.price);
const bundleFor = (look) => state.service.looks.find((l) => l.includes?.includes(look.id)) ?? null;

function longestOpenDay() {
  return Math.max(0, ...Object.values(state.settings.hours).filter(Boolean).map((h) => toMins(h.close) - toMins(h.open)));
}

// Most people one booking can take: the look's own limit, and what fits in the longest day.
function qtyMax(look) {
  return Math.max(1, Math.min(look.maxQty || 1, Math.floor(longestOpenDay() / look.mins) || 1));
}

// What the client is booking right now: one service, or one look of it (times the number of people).
function order() {
  const svc = state.service;
  if (!svc) return null;
  if (!hasLooks(svc)) return { title: svc.name, price: svc.price, mins: svc.mins, look: null, qty: 1 };
  const look = selectedLook();
  if (!look) return null;
  const qty = look.perPerson ? state.qty : 1;
  return {
    title: bookingTitle({ serviceName: svc.name, lookName: look.name, qty }),
    price: look.price * qty,
    mins: look.mins * qty,
    look,
    qty,
  };
}

function renderHeader() {
  const o = order();
  $("#book-service").textContent = o
    ? `${o.title} · ${duration(o.mins)} · ${naira(o.price)}`
    : `${state.service.name} · choose your look`;
}

function lookCard(look) {
  const save = savingOf(look);
  const bundle = !!look.includes?.length;
  const meta = bundle
    ? `Includes ${includedLooks(look).map((l) => l.name).join(" + ")} · ${duration(look.mins)}`
    : look.perPerson ? `${duration(look.mins)} each` : duration(look.mins);
  return `<button type="button" class="look${bundle ? " look-bundle" : ""}" data-look="${esc(look.id)}" aria-pressed="${state.lookId === look.id}">
    ${save ? `<span class="look-badge">Save ${naira(save)}</span>` : ""}
    <span class="look-name">${esc(look.name)}</span>
    <span class="look-price">${save ? `<s class="look-was"><span class="visually-hidden">Was </span>${naira(wasPrice(look))}</s> ` : ""}${naira(look.price)}${look.perPerson ? `<span class="look-per"> per person</span>` : ""}</span>
    <span class="look-meta">${esc(meta)}</span>
  </button>`;
}

// Builds the look cards (once per booking); updateLooks() keeps the rest in step with the choice.
function renderLooks() {
  const svc = state.service;
  $("#look-picker").hidden = !hasLooks(svc);
  if (!hasLooks(svc)) return;
  $("#look-title").textContent = svc.lookTitle || "Choose your look";
  const bundles = svc.looks.filter((l) => l.includes?.length);
  $("#looks-featured").innerHTML = bundles.map(lookCard).join("");
  $("#looks-featured").hidden = bundles.length === 0;
  $("#looks").innerHTML = svc.looks.filter((l) => !l.includes?.length).map(lookCard).join("");
  $("#look-note").textContent = "";
  updateLooks();
}

function updateLooks() {
  const look = selectedLook();
  $$("[data-look]", $("#look-picker")).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.look === state.lookId)));
  $("#look-help").hidden = !!look;

  const qtyBox = $("#look-qty");
  qtyBox.hidden = !look?.perPerson;
  if (look?.perPerson) {
    const max = qtyMax(look);
    state.qty = Math.min(Math.max(1, state.qty), max);
    const input = $("#qty-input");
    input.max = String(max);
    if (document.activeElement !== input) input.value = String(state.qty);
    $("#qty-minus").disabled = state.qty <= 1;
    $("#qty-plus").disabled = state.qty >= max;
    $("#qty-hint").textContent = `${naira(look.price)} per person, ${duration(look.mins)} each. Up to ${max} people in one booking.`;
  }

  // Booking both single wedding looks one by one costs more than the combo: say so.
  const bundle = look && !look.includes?.length ? bundleFor(look) : null;
  const hint = $("#look-hint");
  hint.hidden = !(bundle && savingOf(bundle) > 0);
  hint.innerHTML = bundle && savingOf(bundle) > 0
    ? `Book both and save ${naira(savingOf(bundle))}. <button type="button" class="text-btn" data-switch="${esc(bundle.id)}">Switch to the ${esc(bundle.name.split(":")[0])}</button>`
    : "";

  const o = order();
  const total = $("#look-total");
  total.hidden = !o;
  if (o) {
    const dep = depositFor(o.price, state.settings.depositPct);
    const parts = [];
    if (o.qty > 1) parts.push(`${o.qty} × ${naira(o.look.price)}`);
    if (savingOf(o.look) > 0) parts.push(`you save ${naira(savingOf(o.look))}`);
    parts.push(dep > 0 ? `${naira(dep)} deposit to hold your slot` : "no deposit needed");
    total.innerHTML = `<span class="label">Your total</span><span class="look-total-amt">${naira(o.price)}</span><span class="look-total-sub">${esc(parts.join(" · "))}</span>`;
  }
}

function chooseLook(id) {
  const look = state.service.looks.find((l) => l.id === id);
  if (!look || state.lookId === id) return;
  state.lookId = id;
  state.qty = 1;
  $("#look-note").textContent = "";
  updateLooks();
  renderStep1();
}

function setQty(n) {
  const look = selectedLook();
  if (!look?.perPerson || !Number.isFinite(n)) return;
  state.qty = Math.min(Math.max(1, Math.round(n)), qtyMax(look));
  updateLooks();
  renderStep1();
}

/* ---- step 2 ---- */

function setError(field, msg) {
  const wrap = $(`[data-field="${field}"]`);
  if (!wrap) return false;
  wrap.classList.toggle("has-error", !!msg);
  const err = $(".field-error", wrap);
  err.hidden = !msg;
  err.textContent = msg || "";
  const input = $("input, textarea", wrap);
  if (input) input.setAttribute("aria-invalid", msg ? "true" : "false");
  return true;
}

const cleanName = (v) => v.replace(/\s+/g, " ").trim();
const digitsOf = (v) => v.replace(/\D/g, "");

function validateStep2() {
  const name = cleanName($("#f-name").value);
  const phone = $("#f-phone").value.trim();
  let ok = true;
  const nameErr = name.length < 2 ? "Please add your name." : "";
  const d = digitsOf(phone);
  const phoneErr = !/^[\d+\-() ]+$/.test(phone) || d.length < 10 || d.length > 15 ? "Please enter a WhatsApp number with at least 10 digits." : "";
  setError("name", nameErr);
  setError("phone", phoneErr);
  if (nameErr || phoneErr) {
    ok = false;
    $(nameErr ? "#f-name" : "#f-phone").focus();
  }
  return ok;
}

/* ---- step 3 ---- */

function renderStep3() {
  const s = state.settings;
  const svc = order();
  const deposit = depositFor(svc.price, s.depositPct);
  const free = deposit === 0;
  const choice = !free && canPayInFull(s);
  if (!choice) state.payment = "deposit";
  const full = state.payment === "full";
  const payNow = full ? svc.price : deposit;
  $("#pay-options").hidden = !choice;
  if (choice) {
    $("#pay-grid").innerHTML = [
      ["deposit", "Pay a deposit", deposit, `${s.depositPct}% now, ${naira(svc.price - deposit)} at the studio`],
      ["full", "Pay in full", svc.price, "Nothing more to pay at the studio"],
    ]
      .map(([id, name, amt, note]) => `<button type="button" class="look" data-pay="${id}" aria-pressed="${state.payment === id}">
        <span class="look-name">${name}</span><span class="look-price">${naira(amt)}</span><span class="look-meta">${esc(note)}</span></button>`)
      .join("");
  }
  $("#deposit-label").textContent = full ? "Total to pay now" : "Deposit to pay now";
  $("#deposit-amount").textContent = naira(payNow);
  $("#deposit-sub").textContent = free
    ? `No deposit needed. Your slot is held when you book, and the full ${naira(svc.price)} is paid at the studio.`
    : full
      ? `The full ${naira(svc.price)} for ${svc.title}, ${fmtDate(state.date)} at ${fmtTime(state.time)}. Nothing more to pay at the studio.`
      : `${s.depositPct}% of ${naira(svc.price)} for ${svc.title}, ${fmtDate(state.date)} at ${fmtTime(state.time)}. The remaining ${naira(svc.price - deposit)} is paid at the studio.`;
  $("#bank-card").hidden = free;
  $('[data-field="payer"]').hidden = free;
  $('[data-field="receipt"]').hidden = free;
  $("#s3-submit").textContent = free ? "Book my slot" : "I've paid, book my slot";
  if (!free) {
    const b = s.bank;
    $("#bank-card").innerHTML = [
      ["Bank", b.name, ""],
      ["Account number", b.accountNumber, "acct"],
      ["Account name", b.accountName, ""],
    ]
      .map(([k, v, cls]) => `<div class="bank-row"><div class="bank-lines"><span class="k">${k}</span><span class="v ${cls}">${esc(v)}</span></div>
        <button type="button" class="copy-btn" data-copy="${esc(v)}" aria-label="Copy ${k.toLowerCase()}">Copy</button></div>`)
      .join("");
    wireCopyButtons($("#bank-card"));
    if (!$("#f-payer").value) $("#f-payer").value = cleanName($("#f-name").value);
  }
}

/* ---- receipt: compress to JPEG, max 1200px, ~300KB ---- */

const RECEIPT_MAX_BYTES = 300 * 1024;

async function decodeImage(file) {
  if ("createImageBitmap" in window) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const canvasBlob = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));

async function compressReceipt(file) {
  const img = await decodeImage(file);
  const w0 = img.width || img.naturalWidth;
  const h0 = img.height || img.naturalHeight;
  let scale = Math.min(1, 1200 / Math.max(w0, h0));
  let blob = null;
  for (let round = 0; round < 6; round++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w0 * scale));
    canvas.height = Math.max(1, Math.round(h0 * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const q of [0.82, 0.72, 0.62, 0.52, 0.42]) {
      blob = await canvasBlob(canvas, q);
      if (blob && blob.size <= RECEIPT_MAX_BYTES) return blob;
    }
    scale *= 0.8;
  }
  throw new Error("too big");
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",")[1]);
  reader.onerror = reject;
  reader.readAsDataURL(blob);
});

function clearReceipt() {
  if (state.receipt?.url) URL.revokeObjectURL(state.receipt.url);
  state.receipt = null;
  $("#f-receipt").value = "";
  $("#receipt-preview").hidden = true;
  setError("receipt", "");
}

async function onReceiptPicked(file) {
  if (!file) return;
  setError("receipt", "");
  const btn = $("#receipt-btn");
  btn.textContent = "Preparing…";
  try {
    const blob = await compressReceipt(file);
    const data = await blobToBase64(blob);
    if (state.receipt?.url) URL.revokeObjectURL(state.receipt.url);
    state.receipt = { type: "image/jpeg", data, url: URL.createObjectURL(blob), size: blob.size };
    $("#receipt-img").src = state.receipt.url;
    $("#receipt-meta").textContent = `${Math.round(blob.size / 1024)} KB, ready`;
    $("#receipt-preview").hidden = false;
  } catch {
    clearReceipt();
    setError("receipt", "We couldn't read that image. Try a screenshot or a JPEG or PNG photo.");
  } finally {
    btn.textContent = "Add receipt photo";
  }
}

/* ---- submit ---- */

function setBusy(busy) {
  const btn = $("#s3-submit");
  btn.disabled = busy;
  btn.setAttribute("aria-busy", String(busy));
  if (busy) btn.textContent = "Booking…";
  else renderStep3Label();
}
function renderStep3Label() {
  const free = depositFor(order().price, state.settings.depositPct) === 0;
  $("#s3-submit").textContent = free ? "Book my slot" : "I've paid, book my slot";
}

async function submitBooking(e) {
  e.preventDefault();
  if (state.submitting) return;
  const free = depositFor(order().price, state.settings.depositPct) === 0;
  const payer = cleanName($("#f-payer").value);
  setError("payer", "");
  if (!free && payer.length < 2) {
    setError("payer", "Please add the name on the account you paid from.");
    $("#f-payer").focus();
    return;
  }
  const name = cleanName($("#f-name").value);
  const body = {
    serviceId: state.service.id,
    ...(hasLooks(state.service) ? { lookId: state.lookId, qty: order().qty } : {}),
    date: state.date,
    time: state.time,
    name,
    phone: $("#f-phone").value.trim(),
    note: $("#f-note").value.trim(),
    ...(state.payment === "full" && !free ? { payment: "full" } : {}),
    payer: free ? name : payer,
    receipt: !free && state.receipt ? { type: state.receipt.type, data: state.receipt.data } : null,
  };
  $("#form-error").hidden = true;
  state.submitting = true;
  setBusy(true);
  try {
    const { booking } = await api("/api/book", { method: "POST", body });
    store.write(LS_PROFILE, { name, phone: body.phone });
    remember(booking);
    clearReceipt();
    showTicket(booking, { fresh: true });
    renderMine();
    loadPublic().catch(() => {});
  } catch (err) {
    await handleBookError(err);
  } finally {
    state.submitting = false;
    setBusy(false);
  }
}

async function handleBookError(err) {
  if (!(err instanceof ApiError)) err = new ApiError(0, { message: "Something went wrong. Please try again." });
  if (err.code === "slot_taken" || err.code === "slot_busy") {
    state.time = null;
    await loadPublic().catch(() => {});
    goStep(1);
    renderStep1();
    showTimesMessage(err.message);
    return;
  }
  if (err.status === 400 && err.field) {
    if (["name", "phone", "note"].includes(err.field)) { goStep(2); setError(err.field, err.message); return; }
    if (["time", "date"].includes(err.field)) {
      state.time = null;
      await loadPublic().catch(() => {});
      goStep(1);
      renderStep1();
      showTimesMessage(err.message);
      return;
    }
    if (err.field === "payment") {
      await loadPublic().catch(() => {});
      state.payment = "deposit";
      goStep(3);
      renderStep3();
      const box = $("#form-error");
      box.textContent = err.message;
      box.hidden = false;
      return;
    }
    if (err.field === "look") {
      // The studio changed this service's looks while the client was booking.
      await loadPublic().catch(() => {});
      const fresh = state.settings.services.find((x) => x.id === state.service.id);
      if (fresh) state.service = fresh;
      if (!selectedLook()) state.lookId = null;
      state.time = null;
      renderLooks();
      goStep(1);
      renderStep1();
      $("#look-note").textContent = err.message;
      return;
    }
    if (err.field === "service") {
      await loadPublic().catch(() => {});
      renderAll();
      $("#book").hidden = true;
      scrollToEl($("#services"));
      return;
    }
    if (setError(err.field, err.message)) return;
  }
  const box = $("#form-error");
  box.textContent = err.message;
  box.hidden = false;
}

/* ---------------- tickets & your bookings ---------------- */

function remember(booking) {
  const list = store.read(LS_BOOKINGS, []).filter((b) => b.id !== booking.id);
  list.unshift(booking);
  store.write(LS_BOOKINGS, list.slice(0, 20));
}

// "deposit" or "payment", whichever the client chose to pay.
const payWord = (b) => (b.payment === "full" ? "payment" : "deposit");
const ticketCopy = (b) => ({
  pending: ["Your slot is held", `We'll confirm once your ${payWord(b)} clears. Keep your booking code safe.`],
  confirmed: ["You're confirmed", `Your ${payWord(b)} is confirmed. See you in the chair.`],
  rejected: [`We didn't receive your ${payWord(b)}`, "Your slot has been released. Message us on WhatsApp if you think this is a mistake."],
  done: ["Thank you for coming", "We hope you loved your look."],
  noshow: ["We missed you", "Your slot has been released. Message us on WhatsApp to book again."],
})[b.status] || null;

// quiet: refresh the ticket in place (a status poll) without scrolling or moving focus.
function showTicket(b, { fresh = false, quiet = false } = {}) {
  state.shown = b.id;
  const [title, note] = ticketCopy(b) || ticketCopy({ ...b, status: "pending" });
  const what = bookingTitle(b);
  const msg = `Hi, I've just booked ${what}${b.lookName ? ` (total ${naira(b.price)})` : ""} for ${fmtDate(b.date)} at ${fmtTime(b.time)}. My booking code is ${b.code}. Here is my ${payWord(b)} receipt.`;
  const needsReceipt = b.status === "pending" && !b.hasReceipt && b.deposit > 0;
  $("#ticket-view").innerHTML = `
    <div class="ticket-wrap">
      <div class="ticket-intro">
        <span class="eyebrow">${fresh ? "Booking received" : "Your booking"}</span>
        <h2 id="ticket-title" tabindex="-1">${esc(title)}</h2>
      </div>
      <article class="ticket" aria-label="Booking ticket ${esc(b.code)}">
        <div class="ticket-top">
          <span class="label">${esc(state.settings?.name || "GLAM BY OYIN")}</span>
          <h3 class="ticket-service">${esc(what)}</h3>
          <dl>
            <dt>Date</dt><dd>${esc(fmtDate(b.date))}</dd>
            <dt>Time</dt><dd>${esc(fmtTime(b.time))}</dd>
            ${b.lookName ? `<dt>Total</dt><dd>${naira(b.price)}${b.qty > 1 ? ` (${b.qty} × ${naira(b.unitPrice)})` : ""}</dd>` : ""}
            ${b.payment === "full"
              ? `<dt>Payment</dt><dd>${naira(b.deposit)} in full</dd>
            <dt>Balance</dt><dd>Nothing to pay at the studio</dd>`
              : `<dt>Deposit</dt><dd>${naira(b.deposit)}</dd>
            <dt>Balance</dt><dd>${naira(b.balance)} at the studio</dd>`}
            <dt>Name</dt><dd>${esc(b.name)}</dd>
          </dl>
        </div>
        <div class="ticket-tear" aria-hidden="true"></div>
        <div class="ticket-bottom">
          <span class="label">Booking code</span>
          <div class="ticket-code" aria-label="Booking code ${esc(b.code.split("").join(" "))}">${esc(b.code)}</div>
          ${pill(b.status)}
          ${needsReceipt ? `<div><a class="btn btn-primary btn-sm" href="${esc(waLink(msg))}" target="_blank" rel="noopener">Send receipt on WhatsApp</a></div>` : ""}
          <p class="ticket-note">${esc(note)}</p>
        </div>
      </article>
      <button type="button" class="text-btn" id="ticket-new">Book another look</button>
    </div>`;
  $("#book").hidden = false;
  $("#flow").hidden = true;
  $("#ticket-view").hidden = false;
  $("#ticket-new").addEventListener("click", () => {
    $("#book").hidden = true;
    state.shown = null;
    scrollToEl($("#services"));
  });
  if (quiet) return;
  scrollToEl($("#book"));
  $("#ticket-title").focus({ preventScroll: true });
}

function renderMine() {
  const list = store.read(LS_BOOKINGS, []);
  $("#mine").hidden = list.length === 0;
  $("#my-list").innerHTML = list
    .map((b) => `<button type="button" class="my-item" data-id="${esc(b.id)}">
      <span class="my-name">${esc(bookingTitle(b))}</span>
      <span class="my-when">${esc(fmtDate(b.date, { short: true }))} · ${esc(fmtTime(b.time))} · ${esc(b.code)}</span>
      ${pill(b.status)}</button>`)
    .join("");
}

async function refreshMine() {
  const list = store.read(LS_BOOKINGS, []);
  if (!list.length) return;
  let changed = false;
  const next = [];
  for (const b of list) {
    try {
      const { booking } = await api(`/api/status?id=${encodeURIComponent(b.id)}&code=${encodeURIComponent(b.code)}`);
      if (JSON.stringify(booking) !== JSON.stringify(b)) changed = true;
      next.push(booking);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) { changed = true; continue; } // removed by the studio
      next.push(b); // offline or server hiccup: keep what we have
    }
  }
  if (changed) {
    store.write(LS_BOOKINGS, next);
    renderMine();
    if (state.shown && !$("#ticket-view").hidden) {
      const cur = next.find((b) => b.id === state.shown);
      if (cur) showTicket(cur, { quiet: true });
    }
  }
}

/* ---------------- wiring ---------------- */

function wire() {
  $("#chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat]");
    if (!b) return;
    state.category = b.dataset.cat;
    renderServices();
  });
  $("#services-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-service]");
    if (b) startBooking(b.dataset.service);
  });
  $("#pay-grid").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pay]");
    if (!b || b.dataset.pay === state.payment) return;
    state.payment = b.dataset.pay;
    renderStep3();
    $(`[data-pay="${b.dataset.pay}"]`)?.focus();
  });
  $("#look-picker").addEventListener("click", (e) => {
    const card = e.target.closest("[data-look]");
    if (card) return chooseLook(card.dataset.look);
    if (e.target.closest("#qty-minus")) return setQty(state.qty - 1);
    if (e.target.closest("#qty-plus")) return setQty(state.qty + 1);
    const sw = e.target.closest("[data-switch]");
    if (sw) {
      chooseLook(sw.dataset.switch);
      $(`[data-look="${CSS.escape(sw.dataset.switch)}"]`)?.focus();
    }
  });
  const qtyInput = $("#qty-input");
  // Typing updates the total as you go; leaving the field tidies the number.
  qtyInput.addEventListener("input", () => {
    const n = Number(qtyInput.value);
    if (qtyInput.value !== "" && Number.isInteger(n) && n >= 1) setQty(n);
  });
  qtyInput.addEventListener("change", () => {
    setQty(Number(qtyInput.value));
    qtyInput.value = String(state.qty);
  });
  $("#days").addEventListener("click", (e) => {
    const b = e.target.closest(".day");
    if (!b || b.disabled) return;
    state.date = b.dataset.date;
    state.time = null;
    renderStep1();
  });
  $("#times").addEventListener("click", (e) => {
    const b = e.target.closest(".time");
    if (!b || b.disabled) return;
    state.time = b.dataset.time;
    $$(".time").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    $("#s1-next").disabled = false;
  });
  $("#s1-next").addEventListener("click", () => goStep(2));
  $("#s1-cancel").addEventListener("click", () => {
    $("#book").hidden = true;
    scrollToEl($("#services"));
  });
  $("#step-2").addEventListener("submit", (e) => {
    e.preventDefault();
    if (validateStep2()) goStep(3);
  });
  $("#s2-back").addEventListener("click", () => goStep(1));
  $("#s3-back").addEventListener("click", () => goStep(2));
  $("#step-3").addEventListener("submit", submitBooking);
  $("#f-receipt").addEventListener("change", (e) => onReceiptPicked(e.target.files[0]));
  $("#receipt-btn").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#f-receipt").click(); }
  });
  $("#receipt-remove").addEventListener("click", clearReceipt);
  $("#my-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-id]");
    const booking = b && store.read(LS_BOOKINGS, []).find((x) => x.id === b.dataset.id);
    if (booking) showTicket(booking);
  });
  $$("#step-2 input, #step-2 textarea").forEach((el) => el.addEventListener("input", () => setError(el.closest("[data-field]").dataset.field, "")));
  $("#f-payer").addEventListener("input", () => setError("payer", ""));

  const profile = store.read(LS_PROFILE, null);
  if (profile) {
    $("#f-name").value = profile.name || "";
    $("#f-phone").value = profile.phone || "";
  }
  $$(".step-title").forEach((el) => el.setAttribute("tabindex", "-1"));
}

/* ---------------- gentle reveal for the static sections ---------------- */

let revealCheck = () => {};

function setupReveal() {
  let pending = $$(".reveal");
  const check = () => {
    const vh = innerHeight;
    pending = pending.filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom > 0 && r.top < vh * 0.92) { el.classList.add("is-visible"); return false; }
      return true;
    });
  };
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { check(); ticking = false; });
  };
  revealCheck = check;
  check();
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll);
}

/* ---------------- routing: client site <-> owner desk ---------------- */

let ownerModule = null;

async function route() {
  const owner = location.hash === "#owner";
  document.body.classList.toggle("is-owner", owner);
  $("#client").hidden = owner;
  $("#owner").hidden = !owner;
  $("#nav-cta").hidden = owner;
  $("#nav-back").hidden = !owner;
  document.title = owner ? "Bookings desk · GLAM BY OYIN" : "Book your look · GLAM BY OYIN";
  if (owner) {
    scrollTo(0, 0);
    ownerModule ??= await import("./owner.js");
    ownerModule.mountOwner($("#owner-root"));
  } else {
    ownerModule?.unmountOwner();
    const target = location.hash.length > 1 ? document.getElementById(location.hash.slice(1)) : null;
    if (target && !target.hidden) target.scrollIntoView();
  }
}

/* ---------------- start ---------------- */

async function init() {
  $("#year").textContent = new Date().getFullYear();
  wire();
  setupReveal();
  addEventListener("hashchange", route);
  if (location.hash === "#owner") route();

  const load = async () => {
    try {
      await loadPublic();
      renderAll();
      renderMine();
      refreshMine();
    } catch (err) {
      $("#services-list").innerHTML = `<p class="status-line">${esc(err.message)}</p><button type="button" class="btn btn-outline btn-sm" id="retry">Try again</button>`;
      $("#retry").addEventListener("click", () => { $("#services-list").innerHTML = `<p class="status-line">Loading services…</p>`; load(); });
      renderMine();
    }
  };
  await load();

  setInterval(() => { if (state.settings && !document.hidden) renderFacts(); }, 60000);
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden || !state.settings || location.hash === "#owner") return;
    await loadPublic().catch(() => {});
    renderFacts();
    if (!$("#book").hidden && !$("#flow").hidden && state.step === 1 && state.service) renderStep1();
    refreshMine();
  });
}

init();
