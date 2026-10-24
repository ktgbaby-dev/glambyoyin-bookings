// End-to-end UI test at phone width (400px). Starts its own dev server (mock storage),
// drives the real pages with Playwright, saves screenshots, fails on any console error.
//   npm run test:ui      (screenshots go to $GBO_SHOTS, default <os tmp>/gbo-shots)
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const PORT = 5640;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.GBO_SHOTS || join(tmpdir(), "gbo-shots");
mkdirSync(SHOTS, { recursive: true });

// ---------- tiny harness ----------
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push([false, name]);
    console.log(`  FAIL  ${name}\n        ${String(err.message).split("\n").slice(0, 4).join("\n        ")}`);
  }
}
function check(cond, message) {
  if (!cond) throw new Error(message);
}

// ---------- a big noisy PNG so receipt compression has real work to do ----------
function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function noisyPng(w, h) {
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < w * 3; x++) raw[y * row + 1 + x] = ((x / 3 / w) * 160 + Math.random() * 95) | 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- start the server ----------
const server = spawn(process.execPath, ["--import", pathToFileURL(join(root, "dev/register.js")).href, join(root, "dev/server.js")], {
  env: { ...process.env, PORT: String(PORT), OWNER_PASSWORD: "ui-test-password", SESSION_SECRET: "ui-test-session-secret-ui-test-session" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes("http://") && resolve());
  server.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  setTimeout(() => reject(new Error("server didn't start")), 15000);
});
console.log(`dev server up on ${BASE}; screenshots → ${SHOTS}\n`);

const browser = await chromium.launch();
const errors = [];
// A few non-2xx responses are the point of a test (race loser, wrong password, bad
// settings). Anything else that fails, or any script error, is a real problem.
const expectedFailure = (method, path, status) =>
  (path === "/api/book" && status === 409) ||
  (path === "/api/auth" && method === "POST" && status === 401) ||
  (path === "/api/owner" && method === "POST" && status === 400);
const watch = (page, label) => {
  page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on("console", (m) => {
    // The browser logs every non-2xx fetch as a console error; those are judged by status below.
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(`${label} console: ${m.text()}`);
  });
  page.on("response", (r) => {
    const { pathname } = new URL(r.url());
    if (r.status() >= 400 && !expectedFailure(r.request().method(), pathname, r.status())) {
      errors.push(`${label} unexpected ${r.status()} ${r.request().method()} ${pathname}`);
    }
  });
};
const phone = { viewport: { width: 400, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" };
const newPhone = async (label) => {
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  watch(page, label);
  return { ctx, page };
};
const shot = (page, name, opts = {}) => page.screenshot({ path: join(SHOTS, `${name}.png`), ...opts });
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// drive one client to the deposit step with the first free slot
async function toDeposit(page, { name, phone: tel, serviceId }) {
  await page.goto(BASE + "/");
  await page.waitForSelector("button[data-service]");
  await page.click(serviceId ? `button[data-service="${serviceId}"]` : "button[data-service]");
  await page.waitForSelector(".time:not([disabled])");
  await page.locator(".time:not([disabled])").first().click();
  await page.click("#s1-next");
  await page.fill("#f-name", name);
  await page.fill("#f-phone", tel);
  await page.click("#step-2 button[type=submit]");
  await page.waitForSelector("#step-3:not([hidden])");
}

const A = await newPhone("A");
let bookingA = null;

console.log("Client page");
await step("loads with services, no horizontal scroll at 400px", async () => {
  await A.page.goto(BASE + "/");
  await A.page.waitForSelector("button[data-service]");
  check((await A.page.locator(".service-row").count()) === 7, "expected 7 services");
  check(await noHScroll(A.page), "page scrolls sideways");
  check((await A.page.locator("#facts li").count()) === 3, "facts row incomplete");
  await shot(A.page, "01-home", { fullPage: true });
});

await step("category chips filter the list", async () => {
  await A.page.click('.chip[data-cat="Lashes"]');
  check((await A.page.locator(".service-row").count()) === 4, "lashes filter should show 4");
  await A.page.click('.chip[data-cat="all"]');
  check((await A.page.locator(".service-row").count()) === 7, "all should show 7");
});

await step("step 1: defaults to a free day, past/closed days disabled, a time enables Continue", async () => {
  await A.page.click("button[data-service]");
  await A.page.waitForSelector(".time:not([disabled])");
  check((await A.page.locator(".day[aria-pressed='true']").count()) === 1, "no default day");
  check((await A.page.locator(".day").count()) === 21, "expected 21 days");
  check((await A.page.locator(".day[disabled]").count()) >= 3, "closed days (Mondays) should be disabled");
  check(await A.page.locator("#s1-next").isDisabled(), "Continue should start disabled");
  await A.page.locator(".time:not([disabled])").first().click();
  check(await A.page.locator("#s1-next").isEnabled(), "Continue should enable after picking a time");
  check(await noHScroll(A.page), "sideways scroll in step 1");
  await shot(A.page, "02-step1-time");
});

await step("step 2: validates name and WhatsApp number inline", async () => {
  await A.page.click("#s1-next");
  await A.page.fill("#f-name", "A");
  await A.page.fill("#f-phone", "123");
  await A.page.click("#step-2 button[type=submit]");
  check(await A.page.locator('[data-field="name"] .field-error').isVisible(), "name error not shown");
  await A.page.fill("#f-name", "Ada Obi");
  await A.page.click("#step-2 button[type=submit]");
  check(await A.page.locator('[data-field="phone"] .field-error').isVisible(), "phone error not shown");
  check((await A.page.locator("#step-3:not([hidden])").count()) === 0, "must not advance with a bad number");
  await shot(A.page, "03-step2-errors");
  await A.page.fill("#f-phone", "0813 750 0330");
  await A.page.click("#step-2 button[type=submit]");
  await A.page.waitForSelector("#step-3:not([hidden])");
});

await step("step 3: deposit, bank details with copy buttons, payer prefilled", async () => {
  check((await A.page.textContent("#deposit-amount")).includes("12,500"), "deposit should be ₦12,500 (50% of ₦25,000)");
  const bank = await A.page.textContent("#bank-card");
  for (const s of ["Ecobank", "0250147305", "Obaseki Oyindamola"]) check(bank.includes(s), `bank card missing ${s}`);
  check((await A.page.locator("#bank-card .copy-btn").count()) === 3, "expected 3 copy buttons");
  check((await A.page.inputValue("#f-payer")) === "Ada Obi", "payer should prefill from the name");
  check(await noHScroll(A.page), "sideways scroll in step 3");
});

await step("receipt: a big noisy PNG is compressed to a JPEG under ~300KB", async () => {
  await A.page.setInputFiles("#f-receipt", { name: "receipt.png", mimeType: "image/png", buffer: noisyPng(1800, 1400) });
  await A.page.waitForSelector("#receipt-preview:not([hidden])", { timeout: 15000 });
  const meta = await A.page.textContent("#receipt-meta");
  const kb = Number(meta.match(/(\d+) KB/)?.[1]);
  check(kb > 0 && kb <= 300, `receipt should be ≤300KB, was "${meta}"`);
  const dims = await A.page.evaluate(() => { const i = document.querySelector("#receipt-img"); return [i.naturalWidth, i.naturalHeight]; });
  check(Math.max(...dims) <= 1200, `receipt should be ≤1200px, was ${dims}`);
  await shot(A.page, "04-step3-deposit", { fullPage: false });
});

await step("booking with a receipt gives a ticket with a 6-character code", async () => {
  await A.page.click("#s3-submit");
  await A.page.waitForSelector(".ticket");
  const code = (await A.page.textContent(".ticket-code")).trim();
  check(/^[A-HJKMNP-Z2-9]{6}$/.test(code), `bad code "${code}"`);
  check((await A.page.textContent(".ticket .pill")).includes("Awaiting confirmation"), "wrong status pill");
  const text = await A.page.textContent(".ticket");
  check(text.includes("₦12,500") && text.includes("Ada Obi"), "ticket missing deposit/name");
  check((await A.page.locator(".ticket a[href*='wa.me']").count()) === 0, "receipt was sent, so no WhatsApp receipt button");
  check(await noHScroll(A.page), "sideways scroll on ticket");
  bookingA = { code, id: await A.page.evaluate(() => JSON.parse(localStorage.getItem("gbo:bookings"))[0].id) };
  await shot(A.page, "05-ticket-pending");
});

await step("the booking is remembered: reload shows it under Your bookings", async () => {
  await A.page.reload();
  await A.page.waitForSelector("#my-list .my-item");
  check((await A.page.textContent("#my-list")).includes(bookingA.code), "code missing from Your bookings");
  await A.page.click("#my-list .my-item");
  await A.page.waitForSelector(".ticket");
});

await step("a booking without a receipt offers 'Send receipt on WhatsApp' with the code in the message", async () => {
  await toDeposit(A.page, { name: "Bimpe Ade", phone: "08011112222", serviceId: "lash-refill" });
  await A.page.click("#s3-submit");
  await A.page.waitForSelector(".ticket");
  const href = await A.page.getAttribute(".ticket a[href*='wa.me']", "href");
  const code = (await A.page.textContent(".ticket-code")).trim();
  check(href.startsWith("https://wa.me/2348137500330?text="), `bad wa.me link ${href}`);
  check(decodeURIComponent(href).includes(code), "booking code missing from the WhatsApp message");
  await shot(A.page, "06-ticket-no-receipt");
});

console.log("\nTwo people, one slot");
await step("simultaneous bookings: one ticket, the other is told it's taken and sent back to pick another time", async () => {
  const B = await newPhone("B");
  const C = await newPhone("C");
  // a service/slot nobody has used yet: Volume Lash Extensions (150 min), first free slot
  await Promise.all([
    toDeposit(B.page, { name: "Chioma B", phone: "08033334444", serviceId: "volume-lashes" }),
    toDeposit(C.page, { name: "Dayo C", phone: "08055556666", serviceId: "volume-lashes" }),
  ]);
  const slotB = await B.page.textContent("#deposit-sub");
  const slotC = await C.page.textContent("#deposit-sub");
  check(slotB === slotC, `both should have picked the same slot:\n${slotB}\n${slotC}`);
  await Promise.all([B.page.click("#s3-submit"), C.page.click("#s3-submit")]);
  await Promise.all([
    B.page.waitForSelector(".ticket, #step-1:not([hidden])"),
    C.page.waitForSelector(".ticket, #step-1:not([hidden])"),
  ]);
  const gotTicket = [await B.page.locator(".ticket").count(), await C.page.locator(".ticket").count()];
  check(gotTicket.reduce((a, b) => a + b, 0) === 1, `exactly one ticket expected, got ${gotTicket}`);
  const loser = gotTicket[0] === 0 ? B : C;
  await loser.page.waitForSelector("#times-note:not(:empty)");
  check((await loser.page.textContent("#times-note")).toLowerCase().includes("taken"), "loser should see a 'just taken' message");
  check((await loser.page.locator("#step-1:not([hidden])").count()) === 1, "loser should be back on step 1");
  // Every slot the server says is taken must be unselectable on the loser's page. If a day filled
  // up, the page moves on to the next free day, so check the day button first and the time after.
  await shot(loser.page, "07-slot-just-taken"); // as the loser sees it, before we click around
  const { taken } = await (await fetch(`${BASE}/api/public`)).json();
  check(taken.length >= 3, `expected at least 3 taken slots, got ${taken.length}`);
  for (const t of taken) {
    const day = loser.page.locator(`.day[data-date="${t.date}"]`);
    if (await day.isDisabled()) continue; // closed or fully booked: unselectable
    await day.click();
    const btn = loser.page.locator(`.time[data-time="${t.time}"]`);
    if ((await btn.count()) === 0) continue; // this service can't start then
    check(await btn.isDisabled(), `${t.date} ${t.time} is booked but still selectable`);
  }
  await B.ctx.close();
  await C.ctx.close();
});

console.log("\nOwner desk");
const O = await newPhone("owner");
await step("wrong password is refused, right password opens the desk", async () => {
  await O.page.goto(BASE + "/#owner");
  await O.page.waitForSelector("#owner-pw");
  await shot(O.page, "08-owner-signin");
  await O.page.fill("#owner-pw", "wrong");
  await O.page.click("#signin button[type=submit]");
  await O.page.waitForSelector("#signin .form-error:not([hidden])");
  check((await O.page.textContent("#signin .form-error")).includes("isn't right"), "wrong-password message");
  await O.page.fill("#owner-pw", "ui-test-password");
  await O.page.click("#signin button[type=submit]");
  await O.page.waitForSelector(".stats");
  check(await noHScroll(O.page), "sideways scroll on the desk");
});

await step("stats and filters reflect the bookings; the placeholder reminder shows", async () => {
  const nums = await O.page.locator(".stat .n").allTextContents();
  check(nums[0] === "3", `deposits to check should be 3, was ${nums[0]}`);
  check((await O.page.textContent("#notice-slot")).includes("Still to confirm"), "reminder missing");
  check((await O.page.locator(".bk").count()) === 3, "needs-action list should have 3 cards");
  await shot(O.page, "09-owner-desk", { fullPage: true });
});

await step("view the receipt inline", async () => {
  const card = O.page.locator(".bk", { hasText: bookingA.code });
  await card.locator('[data-action="proof"]').click();
  await card.locator("[data-proof] img").waitFor();
  await O.page.waitForFunction(() => {
    const i = document.querySelector("[data-card] [data-proof] img");
    return i && i.complete && i.naturalWidth > 0;
  });
});

await step("confirm the deposit → it leaves 'Needs action', stats update, the client's ticket says Confirmed", async () => {
  const card = O.page.locator(".bk", { hasText: bookingA.code });
  await card.locator('[data-status="confirmed"]').click();
  // A confirmed booking no longer needs action, so it drops out of that filter.
  await O.page.waitForFunction((code) => ![...document.querySelectorAll(".bk")].some((c) => c.textContent.includes(code)), bookingA.code);
  check((await O.page.locator(".bk").count()) === 2, "two bookings should still need action");
  await O.page.click('[data-filter="all"]'); // stay on "All" for the rest of the owner steps
  await O.page.waitForSelector(`.bk:has-text("${bookingA.code}") .pill-confirmed`);
  const nums = await O.page.locator(".stat .n").allTextContents();
  check(nums[1] === "1", `confirmed upcoming should be 1, was ${nums[1]}`);
  check(nums[2].includes("12,500"), `deposits confirmed should be ₦12,500, was ${nums[2]}`);
  check(nums[3].includes("12,500"), `balance to collect should be ₦12,500, was ${nums[3]}`);
  await A.page.goto(BASE + "/");
  await A.page.waitForSelector("#my-list .my-item .pill-confirmed", { timeout: 10000 });
  await A.page.click("#my-list .my-item:has(.pill-confirmed)");
  await A.page.waitForSelector(".ticket");
  check((await A.page.textContent(".ticket")).includes("Confirmed"), "ticket should say Confirmed");
  await shot(A.page, "10-ticket-confirmed");
});

await step("'Not received' releases the slot so someone else can book it", async () => {
  const before = (await (await fetch(`${BASE}/api/public`)).json()).taken.length;
  const card = O.page.locator(".bk", { hasText: "Bimpe Ade" });
  await card.locator('[data-status="rejected"]').click();
  await O.page.waitForSelector('.bk:has-text("Bimpe Ade") .pill-rejected');
  const after = (await (await fetch(`${BASE}/api/public`)).json()).taken.length;
  check(after === before - 1, `slot should be released (${before} → ${after})`);
});

await step("delete is a two-step inline confirm (no dialogs)", async () => {
  let dialogs = 0;
  O.page.on("dialog", (d) => { dialogs++; d.dismiss(); });
  const card = O.page.locator(".bk", { hasText: "Bimpe Ade" });
  const del = card.locator('[data-action="delete"]');
  await del.click();
  check((await del.textContent()).includes("again"), "first tap should ask again");
  await del.click();
  await O.page.waitForFunction(() => ![...document.querySelectorAll(".bk")].some((c) => c.textContent.includes("Bimpe Ade")));
  check(dialogs === 0, "confirm() dialogs must not be used");
});

await step("settings: save changes, a fresh visitor sees them straight away", async () => {
  await O.page.click('[data-tab="settings"]');
  await O.page.waitForSelector("#settings-form");
  await shot(O.page, "11-owner-settings", { fullPage: true });
  await O.page.fill("#s-deposit", "30");
  await O.page.locator(".svc-edit").first().locator('[data-k="name"]').fill("Soft Glam Plus");
  await O.page.click('[data-action="add-service"]');
  const row = O.page.locator(".svc-edit").last();
  await row.locator('[data-k="name"]').fill("Brow Shape");
  await row.locator('[data-k="price"]').fill("8000");
  await row.locator('[data-k="mins"]').fill("30");
  await O.page.check("#s-confirmed");
  await O.page.click("#settings-form button[type=submit]");
  await O.page.waitForSelector("#save-msg.ok");
  check((await O.page.locator("#notice-slot .notice").count()) === 0, "reminder should clear once confirmed");

  const fresh = await newPhone("fresh");
  await fresh.page.goto(BASE + "/");
  await fresh.page.waitForSelector("button[data-service]");
  const text = await fresh.page.textContent("#services-list");
  check(text.includes("Soft Glam Plus") && text.includes("Brow Shape"), "new service names not visible");
  check(text.includes("₦7,500 deposit"), "30% deposit not applied (Soft Glam ₦25,000 → ₦7,500)");
  check((await fresh.page.textContent("#facts")).includes("30% deposit"), "hero fact not updated");
  await fresh.ctx.close();
});

await step("settings: a bad value is explained, not silently dropped", async () => {
  await O.page.fill("#s-deposit", "150");
  await O.page.click("#settings-form button[type=submit]");
  await O.page.waitForSelector("#save-msg.err");
  check((await O.page.textContent("#save-msg")).includes("between 0 and 100"), "expected a clear deposit error");
});

await step("visitors can't reach owner data", async () => {
  const anon = await browser.newContext();
  const r1 = await anon.request.get(BASE + "/api/owner");
  const r2 = await anon.request.get(BASE + "/api/proof?id=" + bookingA.id);
  check(r1.status() === 401 && r2.status() === 401, `owner ${r1.status()}, proof ${r2.status()}`);
  await anon.close();
});

await step("sign out returns to the sign-in form; 'Back to site' returns to the client page", async () => {
  await O.page.click('[data-action="signout"]');
  await O.page.waitForSelector("#owner-pw");
  await O.page.click("#nav-back");
  await O.page.waitForSelector("button[data-service]");
  check((await O.page.locator("#client:not([hidden])").count()) === 1, "client page should be back");
});

await step("no console or page errors anywhere", async () => {
  check(errors.length === 0, errors.join("\n"));
});

await browser.close();
server.kill();

const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
