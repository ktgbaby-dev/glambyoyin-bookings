// GLAM BY OYIN bookings: owner desk (mounted at /#owner).
import { ApiError, api, bookingTitle, duration, esc, fmtDate, fmtTime, naira, pill, zonedToEpoch } from "./lib.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAMES = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const CATEGORIES = ["Makeup", "Lashes"];
const REFRESH_MS = 60_000;

const state = { root: null, bookings: [], settings: null, filter: "action", tab: "bookings", timer: null, proofOpen: new Set(), mounted: false };

/* ---------------- mount / unmount ---------------- */

export async function mountOwner(root) {
  state.root = root;
  if (!root.dataset.bound) {
    root.dataset.bound = "1";
    root.addEventListener("click", onClick);
    root.addEventListener("submit", onSubmit);
  }
  stopTimer();
  root.innerHTML = `<p class="empty">Loading…</p>`;
  try {
    const { owner } = await api("/api/auth");
    if (owner) await loadDesk();
    else renderSignIn();
  } catch (err) {
    root.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

export function unmountOwner() {
  stopTimer();
  if (state.root) state.root.innerHTML = "";
}

function startTimer() {
  stopTimer();
  state.timer = setInterval(() => {
    if (!document.hidden && state.tab === "bookings" && !editingSomething()) refresh({ quiet: true });
  }, REFRESH_MS);
}
function stopTimer() {
  clearInterval(state.timer);
  state.timer = null;
}
// Don't rebuild the list while the owner is mid-way through a delete confirm.
const editingSomething = () => !!$("[data-armed='1']", state.root);

/* ---------------- sign in ---------------- */

function renderSignIn(message = "") {
  stopTimer();
  state.root.innerHTML = `
    <div class="signin">
      <span class="eyebrow">Studio owner</span>
      <h1>Bookings desk</h1>
      <p>Sign in to see bookings and confirm deposits.</p>
      <form id="signin" novalidate>
        <div class="field">
          <label for="owner-pw">Password</label>
          <input type="password" id="owner-pw" autocomplete="current-password" required>
        </div>
        <p class="form-error" role="alert" ${message ? "" : "hidden"}>${esc(message)}</p>
        <button type="submit" class="btn btn-primary btn-block" style="margin-top:18px">Sign in</button>
      </form>
    </div>`;
  $("#owner-pw").focus();
}

async function signIn(form) {
  const btn = $("button[type=submit]", form);
  const err = $(".form-error", form);
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    await api("/api/auth", { method: "POST", body: { password: $("#owner-pw").value } });
    await loadDesk();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = "Sign in";
    $("#owner-pw").select();
  }
}

async function signOut() {
  try { await api("/api/auth", { method: "DELETE" }); } catch { /* signing out locally anyway */ }
  state.bookings = [];
  state.settings = null;
  renderSignIn();
}

/* ---------------- data ---------------- */

async function loadDesk() {
  await refresh({ first: true });
  startTimer();
}

async function refresh({ quiet = false, first = false } = {}) {
  try {
    const data = await api("/api/owner");
    state.bookings = data.bookings;
    state.settings = data.settings;
    if (first || state.tab === "bookings") renderDesk();
    else renderNoticeOnly();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderSignIn("Your session has ended. Please sign in again.");
    if (!quiet) flash(err.message, true);
  }
}

function flash(message, isError = false) {
  const el = $("#desk-msg", state.root);
  if (!el) return;
  el.textContent = message;
  el.className = `save-msg ${isError ? "err" : "ok"}`;
}

/* ---------------- desk ---------------- */

const slotEpoch = (b) => zonedToEpoch(b.date, b.time, state.settings.tz);
const isUpcoming = (b) => b.status === "confirmed" && slotEpoch(b) + b.mins * 60000 >= Date.now();

function stats() {
  const list = state.bookings;
  const sum = (arr, key) => arr.reduce((n, b) => n + b[key], 0);
  return {
    toCheck: list.filter((b) => b.status === "pending").length,
    upcoming: list.filter(isUpcoming).length,
    confirmedDeposits: sum(list.filter((b) => ["confirmed", "done", "noshow"].includes(b.status)), "deposit"),
    balance: sum(list.filter((b) => b.status === "confirmed"), "balance"),
  };
}

function noticeHtml() {
  if (state.settings.confirmed) return "";
  return `<p class="notice"><strong>Still to confirm:</strong> the prices, opening hours and deposit on the booking page are starting points.
    Update them in Settings, then tick “Confirmed with Oyin” to clear this reminder.</p>`;
}

function renderNoticeOnly() {
  const n = $("#notice-slot", state.root);
  if (n) n.innerHTML = noticeHtml();
}

function renderDesk() {
  const keepScroll = scrollY;
  state.root.innerHTML = `
    <div class="desk-head">
      <h1>Bookings desk</h1>
      <div class="desk-tools">
        <button type="button" class="btn btn-outline btn-sm" data-action="refresh">Refresh</button>
        <button type="button" class="text-btn" data-action="signout">Sign out</button>
      </div>
    </div>
    <div id="notice-slot">${noticeHtml()}</div>
    <div class="tabs" role="tablist">
      <button type="button" class="tab" role="tab" data-tab="bookings" aria-selected="${state.tab === "bookings"}">Bookings</button>
      <button type="button" class="tab" role="tab" data-tab="settings" aria-selected="${state.tab === "settings"}">Settings</button>
    </div>
    <p id="desk-msg" class="save-msg" role="status" aria-live="polite"></p>
    <div id="panel">${state.tab === "bookings" ? bookingsHtml() : settingsHtml()}</div>`;
  if (state.tab === "bookings") restoreProofs();
  scrollTo({ top: keepScroll, behavior: "instant" }); // the page is smooth-scrolling; a refresh shouldn't slide
}

function bookingsHtml() {
  const s = stats();
  const counts = { action: s.toCheck, upcoming: s.upcoming, all: state.bookings.length };
  let list;
  if (state.filter === "action") list = state.bookings.filter((b) => b.status === "pending").sort((a, b) => slotEpoch(a) - slotEpoch(b));
  else if (state.filter === "upcoming") list = state.bookings.filter(isUpcoming).sort((a, b) => slotEpoch(a) - slotEpoch(b));
  else list = state.bookings;

  const empty = {
    action: "Nothing needs checking right now.",
    upcoming: "No confirmed bookings coming up.",
    all: "No bookings yet. They'll appear here as clients book.",
  }[state.filter];

  return `
    <div class="stats">
      <div class="stat ${s.toCheck ? "is-alert" : ""}"><span class="label">Deposits to check</span><span class="n">${s.toCheck}</span></div>
      <div class="stat"><span class="label">Confirmed upcoming</span><span class="n">${s.upcoming}</span></div>
      <div class="stat"><span class="label">Deposits confirmed</span><span class="n">${naira(s.confirmedDeposits)}</span></div>
      <div class="stat"><span class="label">Balance to collect</span><span class="n">${naira(s.balance)}</span></div>
    </div>
    <div class="chips" role="group" aria-label="Filter bookings">
      ${[["action", "Needs action"], ["upcoming", "Upcoming"], ["all", "All"]]
        .map(([k, l]) => `<button type="button" class="chip" data-filter="${k}" aria-pressed="${state.filter === k}">${l} (${counts[k]})</button>`)
        .join("")}
    </div>
    <div class="bk-list">${list.length ? list.map(cardHtml).join("") : `<p class="empty">${empty}</p>`}</div>`;
}

function cardHtml(b) {
  const proofBtn = b.hasReceipt
    ? `<button type="button" class="btn btn-outline" data-action="proof" data-id="${esc(b.id)}">View receipt</button>`
    : "";
  const primary = {
    pending: `<button type="button" class="btn btn-primary" data-action="status" data-status="confirmed" data-id="${esc(b.id)}">Confirm deposit</button>
              <button type="button" class="btn btn-outline" data-action="status" data-status="rejected" data-id="${esc(b.id)}">Not received</button>`,
    confirmed: `<button type="button" class="btn btn-primary" data-action="status" data-status="done" data-id="${esc(b.id)}">Mark completed</button>
                <button type="button" class="btn btn-outline" data-action="status" data-status="noshow" data-id="${esc(b.id)}">No-show</button>`,
  }[b.status] || "";
  const wa = b.phoneWa ? `<a href="https://wa.me/${esc(b.phoneWa)}" target="_blank" rel="noopener">${esc(b.phone)}</a>` : esc(b.phone);
  return `
    <article class="bk" data-card="${esc(b.id)}">
      <div class="bk-head">
        <div>
          <div class="bk-when">${esc(fmtDate(b.date, { short: true }))} · ${esc(fmtTime(b.time))}</div>
          <div class="bk-service">${esc(bookingTitle(b))} · ${esc(duration(b.mins))}</div>
        </div>
        ${pill(b.status)}
      </div>
      <dl>
        <dt>Client</dt><dd>${esc(b.name)}</dd>
        <dt>WhatsApp</dt><dd>${wa}</dd>
        <dt>Deposit</dt><dd>${naira(b.deposit)} of ${naira(b.price)}</dd>
        <dt>Paid by</dt><dd>${esc(b.payer)}</dd>
        <dt>Code</dt><dd class="code">${esc(b.code)}</dd>
        <dt>Receipt</dt><dd>${b.hasReceipt ? "Uploaded" : "Not uploaded"}</dd>
      </dl>
      ${b.note ? `<p class="bk-note">${esc(b.note)}</p>` : ""}
      <div class="bk-actions">
        ${primary}${proofBtn}
        <button type="button" class="btn btn-outline btn-danger" data-action="delete" data-id="${esc(b.id)}">Delete</button>
      </div>
      <p class="form-error" data-msg role="alert" hidden></p>
      <div class="bk-proof" data-proof hidden></div>
    </article>`;
}

function restoreProofs() {
  for (const id of state.proofOpen) {
    const card = $(`[data-card="${CSS.escape(id)}"]`, state.root);
    if (card) showProof(card, id);
    else state.proofOpen.delete(id);
  }
}

function showProof(card, id) {
  const box = $("[data-proof]", card);
  const b = state.bookings.find((x) => x.id === id);
  box.innerHTML = `<img src="/api/proof?id=${encodeURIComponent(id)}" alt="Deposit receipt from ${esc(b?.payer || "client")}">`;
  $("img", box).addEventListener("error", () => { box.innerHTML = `<p class="empty">The receipt couldn't be loaded.</p>`; });
  box.hidden = false;
}

/* ---------------- card actions ---------------- */

function cardError(card, message) {
  const el = $("[data-msg]", card);
  el.textContent = message;
  el.hidden = !message;
}

async function onClick(e) {
  const tab = e.target.closest("[data-tab]");
  if (tab) { state.tab = tab.dataset.tab; renderDesk(); return; }

  const filter = e.target.closest("[data-filter]");
  if (filter) { state.filter = filter.dataset.filter; renderDesk(); return; }

  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  const card = btn.closest("[data-card]");

  if (action === "refresh") return refresh();
  if (action === "signout") return signOut();
  if (action === "add-service") return addServiceRow();
  if (action === "remove-service") return btn.closest(".svc-edit").remove();
  if (action === "add-look") return addLookRow(btn.closest(".svc-edit"));
  if (action === "remove-look") return btn.closest(".look-edit").remove();

  if (action === "proof") {
    const box = $("[data-proof]", card);
    if (!box.hidden) { box.hidden = true; state.proofOpen.delete(id); btn.textContent = "View receipt"; return; }
    state.proofOpen.add(id);
    showProof(card, id);
    btn.textContent = "Hide receipt";
    return;
  }

  if (action === "status") {
    await run(btn, card, () => api("/api/owner", { method: "POST", body: { action: "status", id, status: btn.dataset.status } }));
    return;
  }

  if (action === "delete") {
    // Two-step, inline: no confirm() dialogs.
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = "Tap again to delete";
      clearTimeout(btn._reset);
      btn._reset = setTimeout(() => { btn.dataset.armed = "0"; btn.textContent = "Delete"; }, 4000);
      return;
    }
    clearTimeout(btn._reset);
    state.proofOpen.delete(id);
    await run(btn, card, () => api("/api/owner", { method: "POST", body: { action: "delete", id } }));
  }
}

async function run(btn, card, fn) {
  cardError(card, "");
  $$("button", card).forEach((b) => { b.disabled = true; });
  try {
    await fn();
    await refresh();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderSignIn("Your session has ended. Please sign in again.");
    $$("button", card).forEach((b) => { b.disabled = false; });
    btn.dataset.armed = "0";
    if (btn.dataset.action === "delete") btn.textContent = "Delete";
    cardError(card, err.message);
  }
}

/* ---------------- settings ---------------- */

function settingsHtml() {
  const s = state.settings;
  const field = (id, label, value, attrs = "") =>
    `<div class="field"><label for="${id}">${label}</label><input type="text" id="${id}" value="${esc(value)}" ${attrs}></div>`;
  return `
    <form class="settings-form" id="settings-form" novalidate>
      <fieldset>
        <legend>Studio</legend>
        <div class="grid2">
          ${field("s-name", "Studio name", s.name, 'maxlength="60"')}
          ${field("s-area", "Area", s.area, 'maxlength="60"')}
        </div>
        ${field("s-tagline", "Tagline", s.tagline, 'maxlength="120"')}
        <div class="grid2">
          ${field("s-whatsapp", "WhatsApp number (with country code)", s.whatsapp, 'inputmode="tel" maxlength="20"')}
          ${field("s-email", "Email", s.email, 'inputmode="email" maxlength="120"')}
        </div>
        ${field("s-instagram", "Instagram link", s.instagram, 'maxlength="200"')}
      </fieldset>

      <fieldset>
        <legend>Deposit and bank details</legend>
        <div class="field"><label for="s-deposit">Deposit (% of the price)</label>
          <input type="number" id="s-deposit" min="0" max="100" step="1" inputmode="numeric" value="${esc(s.depositPct)}"></div>
        <div class="grid2">
          ${field("s-bank", "Bank", s.bank.name, 'maxlength="60"')}
          ${field("s-acct", "Account number", s.bank.accountNumber, 'inputmode="numeric" maxlength="20"')}
        </div>
        ${field("s-acctname", "Account name", s.bank.accountName, 'maxlength="80"')}
      </fieldset>

      <fieldset>
        <legend>Opening hours</legend>
        ${DAY_ORDER.map((d) => {
          const h = s.hours[d];
          return `<div class="hours-row" data-day="${d}">
            <span class="d">${DAY_NAMES[d]}</span>
            <div class="field"><input type="time" step="1800" aria-label="${DAY_NAMES[d]} opens" value="${h ? h.open : "09:00"}" ${h ? "" : "disabled"}></div>
            <div class="field"><input type="time" step="1800" aria-label="${DAY_NAMES[d]} closes" value="${h ? h.close : "18:00"}" ${h ? "" : "disabled"}></div>
            <label class="closed"><input type="checkbox" ${h ? "" : "checked"}> Closed</label>
          </div>`;
        }).join("")}
      </fieldset>

      <fieldset>
        <legend>Services</legend>
        <div id="svc-list">${s.services.map(serviceRowHtml).join("")}</div>
        <button type="button" class="btn btn-outline btn-sm" data-action="add-service" style="margin-top:14px">Add a service</button>
      </fieldset>

      <fieldset>
        <legend>Booking policy</legend>
        <div class="field"><label for="s-policy">Shown to clients on the booking page</label>
          <textarea id="s-policy" maxlength="1000">${esc(s.policy)}</textarea></div>
      </fieldset>

      <div class="confirm-box">
        <input type="checkbox" id="s-confirmed" ${s.confirmed ? "checked" : ""}>
        <label for="s-confirmed">Confirmed with Oyin: the prices, opening hours and deposit above are final.</label>
      </div>
      <div class="save-bar">
        <button type="submit" class="btn btn-primary">Save changes</button>
        <span class="save-msg" id="save-msg" role="status" aria-live="polite"></span>
      </div>
    </form>`;
}

// One look of a service that is booked by look (Bridal Glam). A bundle's minutes are
// the sum of the looks it includes, so they are shown but not editable.
function lookRowHtml(look = {}, siblings = []) {
  const bundle = Array.isArray(look.includes) && look.includes.length;
  const names = bundle ? look.includes.map((id) => siblings.find((l) => l.id === id)?.name || id).join(" + ") : "";
  return `<div class="look-edit" data-id="${esc(look.id || "")}" data-includes="${esc(bundle ? look.includes.join(",") : "")}">
    <div class="field"><label>Look name</label><input type="text" data-lk="name" maxlength="60" value="${esc(look.name || "")}"></div>
    <div class="row2">
      <div class="field"><label>Price (₦)</label><input type="number" data-lk="price" min="0" step="500" inputmode="numeric" value="${esc(look.price ?? "")}"></div>
      <div class="field"><label>Minutes${bundle ? "" : look.perPerson ? " each" : ""}</label><input type="number" data-lk="mins" min="30" max="480" step="30" inputmode="numeric" value="${esc(look.mins ?? 60)}" ${bundle ? "disabled" : ""}></div>
    </div>
    ${bundle
      ? `<p class="hint look-edit-note">Bundle of ${esc(names)}. Its time is the two looks together.</p>`
      : `<div class="row2">
          <label class="closed"><input type="checkbox" data-lk="perPerson" ${look.perPerson ? "checked" : ""}> Priced per person</label>
          <div class="field" ${look.perPerson ? "" : "hidden"}><label>Most people</label><input type="number" data-lk="maxQty" min="2" max="20" step="1" inputmode="numeric" value="${esc(look.maxQty ?? 8)}" ${look.perPerson ? "" : "disabled"}></div>
        </div>`}
    <button type="button" class="btn btn-outline btn-danger btn-sm" data-action="remove-look" aria-label="Remove ${esc(look.name || "look")}">Remove look</button>
  </div>`;
}

function addLookRow(svcRow) {
  const list = $(".look-edit-list", svcRow);
  list.insertAdjacentHTML("beforeend", lookRowHtml({ mins: 60 }));
  $$(".look-edit input[data-lk=name]", list).at(-1).focus();
}

function serviceRowHtml(svc = {}) {
  if (svc.looks?.length) {
    return `<div class="svc-edit svc-has-looks" data-id="${esc(svc.id || "")}" data-look-title="${esc(svc.lookTitle || "")}">
      <div class="field"><label>Service name</label><input type="text" data-k="name" maxlength="60" value="${esc(svc.name || "")}"></div>
      <div class="row2">
        <div class="field"><label>Category</label>
          <select data-k="category">${CATEGORIES.map((c) => `<option ${svc.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
        <div class="field"><button type="button" class="btn btn-outline btn-danger btn-sm btn-block" data-action="remove-service" aria-label="Remove ${esc(svc.name || "service")}">Remove</button></div>
      </div>
      <div class="looks-edit">
        <h4 class="label">Looks</h4>
        <p class="hint">Clients choose one look per booking. The list shows this service "from" its lowest look price.</p>
        <div class="look-edit-list">${svc.looks.map((l) => lookRowHtml(l, svc.looks)).join("")}</div>
        <button type="button" class="btn btn-outline btn-sm" data-action="add-look" style="margin-top:12px">Add a look</button>
      </div>
    </div>`;
  }
  return `<div class="svc-edit" data-id="${esc(svc.id || "")}">
    <div class="field"><label>Service name</label><input type="text" data-k="name" maxlength="60" value="${esc(svc.name || "")}"></div>
    <div class="row2">
      <div class="field"><label>Category</label>
        <select data-k="category">${CATEGORIES.map((c) => `<option ${svc.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
      <div class="field"><label>Price (₦)</label><input type="number" data-k="price" min="0" step="500" inputmode="numeric" value="${esc(svc.price ?? "")}"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Minutes</label><input type="number" data-k="mins" min="30" max="480" step="30" inputmode="numeric" value="${esc(svc.mins ?? 60)}"></div>
      <div class="field"><button type="button" class="btn btn-outline btn-danger btn-sm btn-block" data-action="remove-service" aria-label="Remove ${esc(svc.name || "service")}">Remove</button></div>
    </div>
  </div>`;
}

function addServiceRow() {
  const list = $("#svc-list", state.root);
  list.insertAdjacentHTML("beforeend", serviceRowHtml({ category: "Makeup", mins: 60 }));
  $$(".svc-edit input[data-k=name]", list).at(-1).focus();
}

function readSettingsForm() {
  const val = (id) => $(id, state.root).value;
  const hours = {};
  for (const row of $$(".hours-row", state.root)) {
    const [open, close] = $$("input[type=time]", row);
    hours[row.dataset.day] = $("input[type=checkbox]", row).checked ? null : { open: open.value, close: close.value };
  }
  const services = $$(".svc-edit", state.root).map((row) => {
    const get = (k) => $(`[data-k="${k}"]`, row).value;
    const svc = { name: get("name"), category: get("category") };
    if (row.dataset.id) svc.id = row.dataset.id;
    if ($(".looks-edit", row)) {
      svc.lookTitle = row.dataset.lookTitle || "";
      svc.looks = $$(".look-edit", row).map((lr) => {
        const lk = (k) => $(`[data-lk="${k}"]`, lr);
        const look = { name: lk("name").value, price: Number(lk("price").value) };
        if (lr.dataset.id) look.id = lr.dataset.id;
        if (lr.dataset.includes) {
          look.includes = lr.dataset.includes.split(",");
        } else {
          look.mins = Number(lk("mins").value);
          if (lk("perPerson").checked) {
            look.perPerson = true;
            look.maxQty = Number(lk("maxQty").value);
          }
        }
        return look;
      });
    } else {
      svc.price = Number(get("price"));
      svc.mins = Number(get("mins"));
    }
    return svc;
  });
  return {
    name: val("#s-name"),
    area: val("#s-area"),
    tagline: val("#s-tagline"),
    tz: state.settings.tz,
    whatsapp: val("#s-whatsapp"),
    email: val("#s-email"),
    instagram: val("#s-instagram"),
    depositPct: Number(val("#s-deposit")),
    bank: { name: val("#s-bank"), accountNumber: val("#s-acct"), accountName: val("#s-acctname") },
    policy: val("#s-policy"),
    hours,
    services,
    confirmed: $("#s-confirmed", state.root).checked,
  };
}

async function saveSettings() {
  const msg = $("#save-msg", state.root);
  const btn = $("#settings-form button[type=submit]", state.root);
  msg.className = "save-msg";
  msg.textContent = "";
  btn.disabled = true;
  try {
    const { settings } = await api("/api/owner", { method: "POST", body: { action: "settings", settings: readSettingsForm() } });
    state.settings = settings;
    renderNoticeOnly();
    $("#panel", state.root).innerHTML = settingsHtml();
    const m = $("#save-msg", state.root);
    m.className = "save-msg ok";
    m.textContent = "Saved. Clients see these changes now.";
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderSignIn("Your session has ended. Please sign in again.");
    msg.className = "save-msg err";
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- forms ---------------- */

function onSubmit(e) {
  if (e.target.id === "signin") { e.preventDefault(); signIn(e.target); }
  if (e.target.id === "settings-form") { e.preventDefault(); saveSettings(); }
}

// "Closed" ticks disable that day's time inputs.
document.addEventListener("change", (e) => {
  const lookRow = e.target.closest?.(".look-edit");
  if (lookRow && e.target.matches?.("[data-lk=perPerson]")) {
    const max = $("[data-lk=maxQty]", lookRow);
    max.disabled = !e.target.checked;
    max.closest(".field").hidden = !e.target.checked;
  }
  const row = e.target.closest?.(".hours-row");
  if (row && e.target.type === "checkbox") {
    $$("input[type=time]", row).forEach((t) => { t.disabled = e.target.checked; });
  }
});
