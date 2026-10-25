// GLAM BY OYIN bookings: owner desk (mounted at /#owner).
import { ApiError, api, bookingTitle, duration, esc, fmtDate, fmtHold, fmtTime, isAllDay, naira, pill, zonedToEpoch } from "./lib.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAMES = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const CATEGORIES = ["Makeup", "Lashes"];
const REFRESH_MS = 60_000;

const state = {
  root: null, bookings: [], settings: null, filter: "action", tab: "bookings", timer: null, proofOpen: new Set(), mounted: false,
  skew: 0, // server clock minus this device's clock, so "expired" agrees with the server
  user: null, // the signed-in login
  accounts: false, // true once the studio has separate logins (before that: one shared password)
  users: null, // the list of logins (only for a login that manages logins)
};

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
    const { owner, accounts, user } = await api("/api/auth");
    state.accounts = accounts;
    state.user = user;
    if (owner && user?.mustChange) renderForcedChange();
    else if (owner) await loadDesk();
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
      <p>Sign in to see bookings and confirm payments.</p>
      <form id="signin" novalidate>
        ${state.accounts ? `<div class="field">
          <label for="owner-user">Username</label>
          <input type="text" id="owner-user" autocomplete="username" autocapitalize="none" spellcheck="false" required>
        </div>` : ""}
        <div class="field">
          <label for="owner-pw">Password</label>
          <input type="password" id="owner-pw" autocomplete="current-password" required>
        </div>
        <p class="form-error" role="alert" ${message ? "" : "hidden"}>${esc(message)}</p>
        <button type="submit" class="btn btn-primary btn-block" style="margin-top:18px">Sign in</button>
      </form>
    </div>`;
  ($("#owner-user") || $("#owner-pw")).focus();
}

async function signIn(form) {
  const btn = $("button[type=submit]", form);
  const err = $(".form-error", form);
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const res = await api("/api/auth", { method: "POST", body: { username: $("#owner-user")?.value ?? "", password: $("#owner-pw").value } });
    state.accounts = res.accounts;
    state.user = res.user;
    if (res.user?.mustChange) renderForcedChange();
    else await loadDesk();
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
  state.user = null;
  state.users = null;
  state.tab = "bookings";
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
    state.skew = data.now - Date.now();
    if (first || state.tab === "bookings") renderDesk();
    else renderNoticeOnly();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderSignIn("Your session has ended. Please sign in again.");
    if (err instanceof ApiError && err.code === "must_change") return renderForcedChange();
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

// A pending booking with no receipt whose hold has run out: its slot has been released.
const nowMs = () => Date.now() + state.skew;
const holdExpired = (b) => b.status === "pending" && !!b.holdUntil && b.holdUntil <= nowMs();
const shownStatus = (b) => (holdExpired(b) ? "expired" : b.status);

function stats() {
  const list = state.bookings;
  const sum = (arr, key) => arr.reduce((n, b) => n + b[key], 0);
  return {
    toCheck: list.filter((b) => b.status === "pending" && !holdExpired(b)).length,
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
        ${state.accounts && state.user ? `<span class="signed-in">${esc(state.user.name)}</span>` : ""}
        <button type="button" class="btn btn-outline btn-sm" data-action="refresh">Refresh</button>
        <button type="button" class="text-btn" data-action="signout">Sign out</button>
      </div>
    </div>
    <div id="notice-slot">${noticeHtml()}</div>
    <div class="tabs" role="tablist">
      <button type="button" class="tab" role="tab" data-tab="bookings" aria-selected="${state.tab === "bookings"}">Bookings</button>
      <button type="button" class="tab" role="tab" data-tab="settings" aria-selected="${state.tab === "settings"}">Settings</button>
      ${state.accounts ? `<button type="button" class="tab" role="tab" data-tab="account" aria-selected="${state.tab === "account"}">Account</button>` : ""}
    </div>
    <p id="desk-msg" class="save-msg" role="status" aria-live="polite"></p>
    <div id="panel">${state.tab === "bookings" ? bookingsHtml() : state.tab === "account" ? accountHtml() : settingsHtml()}</div>`;
  if (state.tab === "bookings") restoreProofs();
  if (state.tab === "account") loadLogins();
  scrollTo({ top: keepScroll, behavior: "instant" }); // the page is smooth-scrolling; a refresh shouldn't slide
}

function bookingsHtml() {
  const s = stats();
  const counts = { action: s.toCheck, upcoming: s.upcoming, all: state.bookings.length };
  let list;
  if (state.filter === "action") list = state.bookings.filter((b) => b.status === "pending" && !holdExpired(b)).sort((a, b) => slotEpoch(a) - slotEpoch(b));
  else if (state.filter === "upcoming") list = state.bookings.filter(isUpcoming).sort((a, b) => slotEpoch(a) - slotEpoch(b));
  else list = state.bookings;

  const empty = {
    action: "Nothing needs checking right now.",
    upcoming: "No confirmed bookings coming up.",
    all: "No bookings yet. They'll appear here as clients book.",
  }[state.filter];

  return `
    <div class="stats">
      <div class="stat ${s.toCheck ? "is-alert" : ""}"><span class="label">Payments to check</span><span class="n">${s.toCheck}</span></div>
      <div class="stat"><span class="label">Confirmed upcoming</span><span class="n">${s.upcoming}</span></div>
      <div class="stat"><span class="label">Payments confirmed</span><span class="n">${naira(s.confirmedDeposits)}</span></div>
      <div class="stat"><span class="label">Balance to collect</span><span class="n">${naira(s.balance)}</span></div>
    </div>
    <div class="chips" role="group" aria-label="Filter bookings">
      ${[["action", "Needs action"], ["upcoming", "Upcoming"], ["all", "All"]]
        .map(([k, l]) => `<button type="button" class="chip" data-filter="${k}" aria-pressed="${state.filter === k}">${l} (${counts[k]})</button>`)
        .join("")}
    </div>
    <div class="bk-list">${list.length ? list.map(cardHtml).join("") : `<p class="empty">${empty}</p>`}</div>`;
}

// What happened with this booking's 48 hour reminder email, in plain words.
function reminderRow(b) {
  const r = b.reminder;
  if (!r) return "";
  let text = "";
  if (r.state === "scheduled") text = Number.isFinite(r.sendAtMs) ? `Email set for ${fmtHold(r.sendAtMs, state.settings.tz, nowMs())}` : "Email set";
  else if (r.state === "sent") text = "Email sent";
  else if (r.state === "scheduling") text = "Being set up";
  else if (r.state === "retry") text = `Not set up yet, will try again (${r.lastError || "no answer"})`;
  else if (r.state === "failed") text = `Not sent: ${r.lastError || "it failed"}`;
  else if (r.state === "skipped") text = `None: ${r.reason}`;
  return text ? `<dt>Reminder</dt><dd>${esc(text)}</dd>` : "";
}

function cardHtml(b) {
  const proofBtn = b.hasReceipt
    ? `<button type="button" class="btn btn-outline" data-action="proof" data-id="${esc(b.id)}">View receipt</button>`
    : "";
  const primary = {
    pending: `<button type="button" class="btn btn-primary" data-action="status" data-status="confirmed" data-id="${esc(b.id)}">${b.payment === "full" ? "Confirm payment" : "Confirm deposit"}</button>
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
        ${pill(shownStatus(b))}
      </div>
      <dl>
        <dt>Client</dt><dd>${esc(b.name)}</dd>
        <dt>WhatsApp</dt><dd>${wa}</dd>
        ${b.payment === "full"
          ? `<dt>Payment</dt><dd>${naira(b.deposit)} in full</dd>`
          : `<dt>Deposit</dt><dd>${naira(b.deposit)} of ${naira(b.price)}</dd>`}
        <dt>Paid by</dt><dd>${esc(b.payer)}</dd>
        <dt>Code</dt><dd class="code">${esc(b.code)}</dd>
        <dt>Receipt</dt><dd>${b.hasReceipt ? "Uploaded" : "Not uploaded"}</dd>
        ${reminderRow(b)}
        ${b.status === "pending" && b.holdUntil && !holdExpired(b) ? `<dt>Held until</dt><dd>${esc(fmtHold(b.holdUntil, state.settings.tz, nowMs()))}</dd>` : ""}
      </dl>
      ${holdExpired(b) ? `<p class="bk-note">The hold ran out without a receipt, so this slot was released. Confirm only if the client has paid. It will be booked again if it is still free.</p>` : ""}
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
  box.innerHTML = `<img src="/api/proof?id=${encodeURIComponent(id)}" alt="Payment receipt from ${esc(b?.payer || "client")}">`;
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
  if (action === "gen-pw") return fillGenerated(btn);
  if (action === "reset-open") return openReset(btn);
  if (action === "remove-login") return removeLogin(btn);
  if (action === "sign-out-others") return signOutOthers(btn);
  if (action === "backup-now") return backupNow(btn);
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
        <div class="confirm-box">
          <input type="checkbox" id="s-notify" ${s.notifyNewBookings !== false ? "checked" : ""}>
          <label for="s-notify">Email the address above when a booking comes in.</label>
        </div>
        <div class="confirm-box">
          <input type="checkbox" id="s-remind" ${s.notifyReminders !== false ? "checked" : ""}>
          <label for="s-remind">Email the same address a reminder 48 hours before each appointment.</label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Deposit and bank details</legend>
        <div class="field"><label for="s-deposit">Deposit (% of the price)</label>
          <input type="number" id="s-deposit" min="0" max="100" step="1" inputmode="numeric" value="${esc(s.depositPct)}"></div>
        <div class="field"><label for="s-hold">Hold an unpaid booking for (hours)</label>
          <input type="number" id="s-hold" min="0" max="72" step="1" inputmode="numeric" value="${esc(s.holdHours ?? 3)}">
          <p class="hint">A booking with no receipt keeps its slot this long, then the slot is released. A booking with a receipt is never released until you decide. 0 keeps every booking until you decide.</p></div>
        <div class="confirm-box">
          <input type="checkbox" id="s-fullpay" ${s.allowFullPayment !== false ? "checked" : ""}>
          <label for="s-fullpay">Let clients choose to pay the full price now instead of the deposit. (Shown only when the deposit is between 1% and 99%.)</label>
        </div>
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
          const all = isAllDay(h);
          return `<div class="hours-row" data-day="${d}">
            <span class="d">${DAY_NAMES[d]}</span>
            <div class="field" ${all ? "hidden" : ""}><input type="time" step="1800" aria-label="${DAY_NAMES[d]} opens" value="${h && !all ? h.open : "09:00"}" ${h && !all ? "" : "disabled"}></div>
            <div class="field" ${all ? "hidden" : ""}><input type="time" step="1800" aria-label="${DAY_NAMES[d]} closes" value="${h && !all ? h.close : "18:00"}" ${h && !all ? "" : "disabled"}></div>
            <span class="allday-note" ${all ? "" : "hidden"}>Open 24 hours</span>
            <div class="hours-flags">
              <label class="closed"><input type="checkbox" data-flag="closed" ${h ? "" : "checked"}> Closed</label>
              <label class="closed"><input type="checkbox" data-flag="allday" ${all ? "checked" : ""}> Open 24 hours</label>
            </div>
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
let rowSeq = 0; // rows repeat, so each gets its own ids to tie every label to its field

function lookRowHtml(look = {}, siblings = []) {
  const u = `lk${++rowSeq}`;
  const bundle = Array.isArray(look.includes) && look.includes.length;
  const names = bundle ? look.includes.map((id) => siblings.find((l) => l.id === id)?.name || id).join(" + ") : "";
  return `<div class="look-edit" data-id="${esc(look.id || "")}" data-includes="${esc(bundle ? look.includes.join(",") : "")}">
    <div class="field"><label for="${u}-name">Look name</label><input type="text" id="${u}-name" data-lk="name" maxlength="60" value="${esc(look.name || "")}"></div>
    <div class="row2">
      <div class="field"><label for="${u}-price">Price (₦)</label><input type="number" id="${u}-price" data-lk="price" min="0" step="500" inputmode="numeric" value="${esc(look.price ?? "")}"></div>
      <div class="field"><label for="${u}-mins">Minutes${bundle ? "" : look.perPerson ? " each" : ""}</label><input type="number" id="${u}-mins" data-lk="mins" min="30" max="480" step="30" inputmode="numeric" value="${esc(look.mins ?? 60)}" ${bundle ? "disabled" : ""}></div>
    </div>
    ${bundle
      ? `<p class="hint look-edit-note">Bundle of ${esc(names)}. Its time is the two looks together.</p>`
      : `<div class="row2">
          <label class="closed"><input type="checkbox" data-lk="perPerson" ${look.perPerson ? "checked" : ""}> Priced per person</label>
          <div class="field" ${look.perPerson ? "" : "hidden"}><label for="${u}-max">Most people</label><input type="number" id="${u}-max" data-lk="maxQty" min="2" max="20" step="1" inputmode="numeric" value="${esc(look.maxQty ?? 8)}" ${look.perPerson ? "" : "disabled"}></div>
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
  const u = `sv${++rowSeq}`;
  if (svc.looks?.length) {
    return `<div class="svc-edit svc-has-looks" data-id="${esc(svc.id || "")}" data-look-title="${esc(svc.lookTitle || "")}">
      <div class="field"><label for="${u}-name">Service name</label><input type="text" id="${u}-name" data-k="name" maxlength="60" value="${esc(svc.name || "")}"></div>
      <div class="row2">
        <div class="field"><label for="${u}-cat">Category</label>
          <select id="${u}-cat" data-k="category">${CATEGORIES.map((c) => `<option ${svc.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
        <div class="field"><button type="button" class="btn btn-outline btn-danger btn-sm btn-block" data-action="remove-service" aria-label="Remove ${esc(svc.name || "service")}">Remove</button></div>
      </div>
      <div class="looks-edit">
        <p class="label" role="heading" aria-level="2">Looks</p>
        <p class="hint">Clients choose one look per booking. The list shows this service "from" its lowest look price.</p>
        <div class="look-edit-list">${svc.looks.map((l) => lookRowHtml(l, svc.looks)).join("")}</div>
        <button type="button" class="btn btn-outline btn-sm" data-action="add-look" style="margin-top:12px">Add a look</button>
      </div>
    </div>`;
  }
  return `<div class="svc-edit" data-id="${esc(svc.id || "")}">
    <div class="field"><label for="${u}-name">Service name</label><input type="text" id="${u}-name" data-k="name" maxlength="60" value="${esc(svc.name || "")}"></div>
    <div class="row2">
      <div class="field"><label for="${u}-cat">Category</label>
        <select id="${u}-cat" data-k="category">${CATEGORIES.map((c) => `<option ${svc.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
      <div class="field"><label for="${u}-price">Price (₦)</label><input type="number" id="${u}-price" data-k="price" min="0" step="500" inputmode="numeric" value="${esc(svc.price ?? "")}"></div>
    </div>
    <div class="row2">
      <div class="field"><label for="${u}-mins">Minutes</label><input type="number" id="${u}-mins" data-k="mins" min="30" max="480" step="30" inputmode="numeric" value="${esc(svc.mins ?? 60)}"></div>
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
    if ($("[data-flag=closed]", row).checked) hours[row.dataset.day] = null;
    else if ($("[data-flag=allday]", row).checked) hours[row.dataset.day] = { open: "00:00", close: "24:00" };
    else hours[row.dataset.day] = { open: open.value, close: close.value };
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
    allowFullPayment: $("#s-fullpay", state.root).checked,
    holdHours: Number(val("#s-hold")),
    notifyNewBookings: $("#s-notify", state.root).checked,
    notifyReminders: $("#s-remind", state.root).checked,
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

/* ---------------- logins and passwords ---------------- */

const PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
function generatePassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map((b) => PW_ALPHABET[b % PW_ALPHABET.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

// A temporary password has to be replaced by the person's own before anything else.
function renderForcedChange(message = "") {
  stopTimer();
  state.root.innerHTML = `
    <div class="signin">
      <span class="eyebrow">Hello, ${esc(state.user?.name || "there")}</span>
      <h1>Choose your own password</h1>
      <p>You signed in with a temporary password. Choose one that only you know, at least 10 characters.</p>
      <form id="forced-pw" novalidate>
        ${pwFields({ currentLabel: "Temporary password" })}
        <p class="form-error" role="alert" ${message ? "" : "hidden"}>${esc(message)}</p>
        <button type="submit" class="btn btn-primary btn-block" style="margin-top:18px">Save and continue</button>
        <p style="margin-top:16px;text-align:center"><button type="button" class="text-btn" data-action="signout">Sign out</button></p>
      </form>
    </div>`;
  $("#pw-current").focus();
}

function pwFields({ currentLabel = "Current password" } = {}) {
  return `
    <div class="field"><label for="pw-current">${currentLabel}</label>
      <input type="password" id="pw-current" name="current" autocomplete="current-password" required></div>
    <div class="field"><label for="pw-next">New password</label>
      <input type="password" id="pw-next" name="next" autocomplete="new-password" required>
      <p class="hint">At least 10 characters. Avoid your name, the studio name and common words.</p></div>
    <div class="field"><label for="pw-confirm">New password again</label>
      <input type="password" id="pw-confirm" name="confirm" autocomplete="new-password" required></div>`;
}

function formError(form, message, field) {
  const box = $(".form-error, .save-msg", form);
  if (box) {
    box.textContent = message;
    box.className = box.classList.contains("save-msg") ? "save-msg err" : "form-error";
    box.hidden = !message;
  }
  const input = field && $(`[name="${field}"]`, form);
  if (input) input.focus();
}

async function changePassword(form) {
  const forced = form.id === "forced-pw";
  const val = (name) => $(`[name="${name}"]`, form).value;
  const btn = $("button[type=submit]", form);
  formError(form, "");
  if (val("next") !== val("confirm")) return formError(form, "The two new passwords don't match.", "confirm");
  btn.disabled = true;
  try {
    const { user } = await api("/api/account", { method: "POST", body: { action: "change-password", current: val("current"), next: val("next") } });
    state.user = user;
    if (forced) return await loadDesk();
    form.reset();
    const msg = $(".save-msg", form);
    msg.className = "save-msg ok";
    msg.textContent = "Password changed. Any other phone or computer signed in with this login has been signed out.";
    msg.hidden = false;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderSignIn("Your session has ended. Please sign in again.");
    formError(form, err.message, err.field === "next" ? "next" : err.field === "current" ? "current" : "");
  } finally {
    btn.disabled = false;
  }
}

async function signOutOthers(btn) {
  const msg = $("#others-msg", state.root);
  btn.disabled = true;
  try {
    await api("/api/account", { method: "POST", body: { action: "sign-out-others" } });
    msg.className = "save-msg ok";
    msg.textContent = "Done. You're still signed in here; every other device has been signed out.";
  } catch (err) {
    msg.className = "save-msg err";
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function accountHtml() {
  const u = state.user;
  return `
    <form class="settings-form" id="change-pw" novalidate>
      <fieldset>
        <legend>Your login</legend>
        <p class="hint" style="margin-bottom:14px">Signed in as <strong>${esc(u.name)}</strong> (username <strong>${esc(u.username)}</strong>).</p>
        ${pwFields()}
        <div class="save-bar">
          <button type="submit" class="btn btn-primary">Change password</button>
          <span class="save-msg" role="status" aria-live="polite" hidden></span>
        </div>
      </fieldset>
    </form>
    <div class="settings-form"><fieldset>
      <legend>Other devices</legend>
      <p class="hint">Lost a phone, or signed in on a shared computer? This signs out every other device that is using your login.</p>
      <div class="save-bar" style="margin-top:12px">
        <button type="button" class="btn btn-outline btn-sm" data-action="sign-out-others">Sign out other devices</button>
        <span class="save-msg" id="others-msg" role="status" aria-live="polite"></span>
      </div>
    </fieldset></div>
    <div id="backups"></div>
    <div id="logins">${u.role === "admin" ? `<p class="empty">Loading logins…</p>` : ""}</div>`;
}

const stamp = (iso) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: state.settings?.tz || "Africa/Lagos" })
    .format(new Date(iso)).replace(/\s?([ap])m/i, (_, a) => ` ${a.toLowerCase()}m`);

function backupLine() {
  const b = state.backup;
  if (!b?.configured) return { tone: "err", text: "Backups are not set up yet. Your bookings are not being copied anywhere." };
  const last = b.last;
  if (!last) return { tone: "", text: "No backup has run yet. The first one runs tonight, or tap Back up now." };
  const good = last.lastOkAt ? ` The last good copy is from ${stamp(last.lastOkAt)}.` : " There is no good copy yet.";
  if (!last.ok) return { tone: "err", text: `The last attempt (${stamp(last.at)}) did not finish: ${last.message}.${good}` };
  const days = (state.serverNow - Date.parse(last.at)) / 86_400_000;
  const stale = days > 2 ? ` That was ${Math.floor(days)} days ago, so the nightly copy may have stopped.` : "";
  const parts = [`${last.bookings} booking${last.bookings === 1 ? "" : "s"}`, `${last.receipts} receipt${last.receipts === 1 ? "" : "s"}`];
  return { tone: stale ? "err" : "ok", text: `Last backup ${stamp(last.at)}: ${parts.join(" and ")} copied and checked. ${last.snapshotsKept === 1 ? "One night is kept so far." : `The last ${last.snapshotsKept} nights are kept.`}${last.partial ? " Some receipts are still to copy and will finish tonight." : ""}${stale}` };
}

function backupsHtml() {
  const { tone, text } = backupLine();
  return `
    <div class="settings-form"><fieldset>
      <legend>Backups</legend>
      <p class="hint backup-line ${tone}" id="backup-line">${esc(text)}</p>
      <p class="hint" style="margin-top:8px">Every night a copy of the bookings, settings, logins and receipts goes to a separate store, and the last 30 nights are kept. “Download a copy” saves your bookings and settings to this device (no logins or receipts).</p>
      <div class="save-bar" style="margin-top:12px">
        <button type="button" class="btn btn-outline btn-sm" data-action="backup-now">Back up now</button>
        <a class="btn btn-outline btn-sm" href="/api/account?download=backup" download>Download a copy</a>
        <span class="save-msg" id="backup-msg" role="status" aria-live="polite"></span>
      </div>
    </fieldset></div>`;
}

async function backupNow(btn) {
  const msg = $("#backup-msg", state.root);
  btn.disabled = true;
  msg.className = "save-msg";
  msg.textContent = "Backing up…";
  try {
    const res = await api("/api/account", { method: "POST", body: { action: "backup-now" } });
    state.backup = res.backup;
    state.serverNow = res.now;
    const box = $("#backups", state.root);
    if (box) box.innerHTML = backupsHtml();
    const again = $("#backup-msg", state.root);
    again.className = `save-msg ${res.result.ok ? "ok" : "err"}`;
    again.textContent = res.result.ok ? "Done." : res.result.message;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderSignIn("Your session has ended. Please sign in again.");
    msg.className = "save-msg err";
    msg.textContent = err.message;
    btn.disabled = false;
  }
}

async function loadLogins() {
  if (state.user?.role !== "admin") return;
  try {
    const data = await api("/api/account");
    state.users = data.users || [];
    state.backup = data.backup;
    state.serverNow = data.now;
    const backups = $("#backups", state.root);
    if (backups) backups.innerHTML = backupsHtml();
    const box = $("#logins", state.root);
    if (box) box.innerHTML = loginsHtml();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderSignIn("Your session has ended. Please sign in again.");
    const box = $("#logins", state.root);
    if (box) box.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

function loginsHtml() {
  const me = state.user;
  const rows = state.users
    .map((u) => `
      <li class="login-row" data-uid="${esc(u.id)}">
        <div class="login-who">
          <strong>${esc(u.name)}</strong>${u.id === me.id ? ` <span class="tag">you</span>` : ""}
          <span class="hint">${esc(u.username)} · ${u.role === "admin" ? "manages logins" : "studio login"}${u.mustChange ? " · still on a temporary password" : ""}</span>
        </div>
        <div class="login-actions">
          <button type="button" class="btn btn-outline btn-sm" data-action="reset-open" data-uid="${esc(u.id)}">Reset password</button>
          ${u.id === me.id ? "" : `<button type="button" class="btn btn-outline btn-danger btn-sm" data-action="remove-login" data-uid="${esc(u.id)}" data-name="${esc(u.name)}">Remove</button>`}
        </div>
        <form class="login-reset" data-uid="${esc(u.id)}" novalidate hidden>
          <div class="field"><label for="rp-${esc(u.id)}">New ${u.id === me.id ? "" : "temporary "}password for ${esc(u.name)}</label>
            <input type="text" id="rp-${esc(u.id)}" name="password" autocomplete="off" autocapitalize="none" spellcheck="false">
            <p class="hint">${u.id === me.id ? "This becomes your password straight away." : `${esc(u.name)} will be asked to choose their own the next time they sign in.`}</p></div>
          <div class="save-bar">
            <button type="button" class="btn btn-outline btn-sm" data-action="gen-pw">Generate one</button>
            <button type="submit" class="btn btn-primary btn-sm">Save new password</button>
          </div>
          <p class="save-msg" role="status" aria-live="polite" hidden></p>
        </form>
      </li>`)
    .join("");
  return `
    <div class="settings-form"><fieldset>
      <legend>Logins</legend>
      <ul class="logins">${rows}</ul>
    </fieldset></div>
    <form class="settings-form" id="add-login" novalidate>
      <fieldset>
        <legend>Add a login</legend>
        <div class="grid2">
          <div class="field"><label for="al-name">Name</label><input type="text" id="al-name" name="name" maxlength="60" autocomplete="off"></div>
          <div class="field"><label for="al-user">Username</label><input type="text" id="al-user" name="username" maxlength="32" autocomplete="off" autocapitalize="none" spellcheck="false"></div>
        </div>
        <div class="field"><label for="al-pass">Temporary password</label>
          <input type="text" id="al-pass" name="password" autocomplete="off" autocapitalize="none" spellcheck="false">
          <p class="hint">They choose their own the first time they sign in. Tap Generate, then send it to them privately.</p></div>
        <div class="confirm-box">
          <input type="checkbox" id="al-admin" name="admin">
          <label for="al-admin">Can manage logins (add, reset and remove other logins).</label>
        </div>
        <div class="save-bar">
          <button type="button" class="btn btn-outline btn-sm" data-action="gen-pw">Generate one</button>
          <button type="submit" class="btn btn-primary">Add login</button>
          <span class="save-msg" role="status" aria-live="polite" hidden></span>
        </div>
      </fieldset>
    </form>`;
}

function fillGenerated(btn) {
  const form = btn.closest("form");
  const input = $("[name=password]", form);
  input.value = generatePassword();
  input.focus();
  input.select();
}

function openReset(btn) {
  const form = $(`.login-reset[data-uid="${CSS.escape(btn.dataset.uid)}"]`, state.root);
  form.hidden = !form.hidden;
  if (!form.hidden) $("[name=password]", form).focus();
}

function say(form, text, ok) {
  const el = $(".save-msg", form);
  el.className = `save-msg ${ok ? "ok" : "err"}`;
  el.textContent = text;
  el.hidden = !text;
}

async function resetLogin(form) {
  const uid = form.dataset.uid;
  const password = $("[name=password]", form).value;
  const btn = $("button[type=submit]", form);
  say(form, "", true);
  btn.disabled = true;
  try {
    const { user } = await api("/api/account", { method: "POST", body: { action: "reset", id: uid, password } });
    if (uid === state.user.id) state.user = user;
    await loadLogins();
    const again = $(`.login-reset[data-uid="${CSS.escape(uid)}"]`, state.root);
    again.hidden = false;
    $("[name=password]", again).value = password;
    say(again, uid === state.user.id ? "Your password has been changed." : `Saved. Send ${user.name} this temporary password: ${password}. They will choose their own when they sign in.`, true);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderSignIn("Your session has ended. Please sign in again.");
    say(form, err.message, false);
    btn.disabled = false;
  }
}

async function addLogin(form) {
  const val = (name) => $(`[name="${name}"]`, form).value;
  const btn = $("button[type=submit]", form);
  say(form, "", true);
  btn.disabled = true;
  try {
    const body = { action: "add", name: val("name"), username: val("username"), password: val("password"), role: $("[name=admin]", form).checked ? "admin" : "member" };
    const { user } = await api("/api/account", { method: "POST", body });
    await loadLogins();
    const box = $("#add-login", state.root);
    say(box, `Added ${user.name}. Send them the username “${user.username}” and this temporary password: ${body.password}. They will choose their own when they first sign in.`, true);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderSignIn("Your session has ended. Please sign in again.");
    say(form, err.message, false);
    const bad = err.field && $(`[name="${err.field}"]`, form);
    if (bad) bad.focus();
    btn.disabled = false;
  }
}

async function removeLogin(btn) {
  // Two taps, inline, like deleting a booking.
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = `Tap again to remove ${btn.dataset.name}`;
    clearTimeout(btn._reset);
    btn._reset = setTimeout(() => { btn.dataset.armed = "0"; btn.textContent = "Remove"; }, 4000);
    return;
  }
  clearTimeout(btn._reset);
  btn.disabled = true;
  try {
    await api("/api/account", { method: "POST", body: { action: "remove", id: btn.dataset.uid } });
    await loadLogins();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderSignIn("Your session has ended. Please sign in again.");
    btn.disabled = false;
    btn.dataset.armed = "0";
    btn.textContent = "Remove";
    alertInline(btn, err.message);
  }
}

function alertInline(btn, message) {
  const row = btn.closest(".login-row");
  let el = $(".login-error", row);
  if (!el) {
    row.insertAdjacentHTML("beforeend", `<p class="form-error login-error" role="alert"></p>`);
    el = $(".login-error", row);
  }
  el.textContent = message;
}

/* ---------------- forms ---------------- */

function onSubmit(e) {
  if (e.target.id === "signin") { e.preventDefault(); signIn(e.target); }
  if (e.target.id === "settings-form") { e.preventDefault(); saveSettings(); }
  if (e.target.id === "change-pw" || e.target.id === "forced-pw") { e.preventDefault(); changePassword(e.target); }
  if (e.target.id === "add-login") { e.preventDefault(); addLogin(e.target); }
  if (e.target.matches(".login-reset")) { e.preventDefault(); resetLogin(e.target); }
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
  if (row && e.target.matches?.("[data-flag]")) {
    const closed = $("[data-flag=closed]", row).checked;
    const all = $("[data-flag=allday]", row).checked && !closed;
    $$(".field", row).forEach((f) => { f.hidden = all; });
    $(".allday-note", row).hidden = !all;
    $$("input[type=time]", row).forEach((t) => { t.disabled = closed || all; });
  }
});
