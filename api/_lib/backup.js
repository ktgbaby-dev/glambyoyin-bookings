// Backups: a nightly copy of the whole store into a SECOND private Blob store (its own token), and the way back.
//
//   in the backup store
//     snapshots/YYYY-MM-DD.json  every JSON document of the main store, as exact text. The last 30 days are kept.
//     proofs/<id>                receipt images, copied once. One whose booking is gone is dropped after 30 days.
//     state.json                 what the last run saw, so a quiet night only reads what changed.
//   in the main store
//     backup/status.json         what the desk shows (last run, last good run)
//
// rl/ (rate-limit counters) and backup/ are not copied. Nothing here can change bookings: it only reads the
// main store, and the only thing it writes there is backup/status.json.
import { createHash } from "node:crypto";
import { BlobNotFoundError, del, get, list, put } from "@vercel/blob";
import { listAll, mapLimit, readFile, readJson, remove, writeFile, writeJson } from "./store.js";

export const TOKEN_ENV = "BACKUP_BLOB_READ_WRITE_TOKEN";
export const KEEP_SNAPSHOTS = 30;
export const KEEP_PROOF_DAYS = 30;
const TIME_BUDGET_MS = 40_000; // stop copying receipts after this; the next night carries on
const STATUS_PATH = "backup/status.json";
const NOT_COPIED = ["rl/", "backup/"];

export const backupConfigured = () => !!process.env[TOKEN_ENV];
const sha = (s) => createHash("sha256").update(s).digest("hex");
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// Never let a token end up in a message the desk or an email shows.
export function plainError(err) {
  return String(err?.message || err || "unknown error").replace(/vercel_blob_rw_[A-Za-z0-9_]+/g, "[token]").slice(0, 300);
}

// ---------- the backup store ----------

const opts = (extra = {}) => ({ access: "private", token: process.env[TOKEN_ENV], ...extra });

async function bRead(pathname) {
  try {
    const res = await get(pathname, opts({ useCache: false }));
    if (!res || res.statusCode !== 200 || !res.stream) return null;
    return { buffer: Buffer.from(await new Response(res.stream).arrayBuffer()), contentType: res.blob?.contentType };
  } catch (err) {
    if (err instanceof BlobNotFoundError) return null;
    throw err;
  }
}
const bReadJson = async (pathname) => {
  const r = await bRead(pathname);
  return r ? JSON.parse(r.buffer.toString("utf8")) : null;
};
const bWrite = (pathname, body, contentType) =>
  put(pathname, body, opts({ contentType, addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 }));
async function bList(prefix) {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000, token: process.env[TOKEN_ENV] });
    out.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}
const bDelete = async (pathnames) => {
  if (pathnames.length) await del(pathnames, opts());
};

// ---------- the main store ----------

async function readText(pathname) {
  const f = await readFile(pathname);
  return f ? await new Response(f.stream).text() : null;
}
const isProof = (p) => p.startsWith("proofs/");
const isCopiedDoc = (p) => !isProof(p) && !NOT_COPIED.some((x) => p.startsWith(x));
// What goes in a downloadable copy: the studio's own records, without logins or receipts.
const isStudioDoc = (p) => p === "settings.json" || p.startsWith("bookings/") || p.startsWith("days/");

const sorted = (docs) => Object.fromEntries(Object.entries(docs).sort(([a], [b]) => (a < b ? -1 : 1)));
const countOf = (docs, prefix) => Object.keys(docs).filter((p) => p.startsWith(prefix)).length;

// ---------- the nightly run ----------

export async function readStatus() {
  return (await readJson(STATUS_PATH).catch(() => null))?.data ?? null;
}

async function saveStatus(summary) {
  const before = await readStatus();
  const status = { ...summary, lastOkAt: summary.ok ? summary.at : before?.lastOkAt ?? null };
  await writeJson(STATUS_PATH, status).catch((err) => console.error(`Backup status not saved: ${plainError(err)}`));
  return status;
}

export async function backupStatus() {
  return { configured: backupConfigured(), last: await readStatus() };
}

// Copies what changed since the last run. Never throws: the answer says whether it worked.
export async function runBackup({ now = Date.now(), by = "daily" } = {}) {
  if (!backupConfigured()) {
    return { ok: false, reason: "not_configured", at: new Date(now).toISOString(), message: `Backups are not set up (${TOKEN_ENV} is missing).` };
  }
  const t0 = performance.now();
  const at = new Date(now).toISOString();
  try {
    const primary = await listAll("");
    const state = (await bReadJson("state.json")) || { etags: {}, proofs: {} };
    const previous = state.lastSnapshot ? await bReadJson(state.lastSnapshot) : null;
    const before = previous?.docs || {};

    // 1. every JSON document: reuse last night's text when its version tag has not changed
    const docs = {};
    const etags = {};
    let reused = 0;
    let fetched = 0;
    await mapLimit(primary.filter((b) => isCopiedDoc(b.pathname)), 8, async (b) => {
      if (state.etags?.[b.pathname] === b.etag && typeof before[b.pathname] === "string") {
        docs[b.pathname] = before[b.pathname];
        etags[b.pathname] = b.etag;
        reused++;
        return;
      }
      const text = await readText(b.pathname);
      if (text === null) return; // removed while we were reading: it is not in tonight's copy
      docs[b.pathname] = text;
      etags[b.pathname] = b.etag;
      fetched++;
    });

    // 2. write the snapshot and read it straight back, so "backed up" means "can be read again"
    const snapshotPath = `snapshots/${dayOf(now)}.json`;
    const body = JSON.stringify({ version: 1, kind: "snapshot", takenAt: at, docs: sorted(docs) });
    await bWrite(snapshotPath, body, "application/json");
    const back = await bRead(snapshotPath);
    if (!back || sha(back.buffer.toString("utf8")) !== sha(body)) throw new Error("The copy was written but did not read back the same");

    // 3. receipts: copy the ones not copied yet; forget the ones whose booking is long gone
    const proofs = { ...(state.proofs || {}) };
    const seen = new Set();
    const todo = [];
    for (const b of primary.filter((x) => isProof(x.pathname))) {
      seen.add(b.pathname);
      const known = proofs[b.pathname];
      if (known && known.etag === b.etag) delete known.missingSince;
      else todo.push(b);
    }
    let copied = 0;
    let partial = false;
    await mapLimit(todo, 4, async (b) => {
      if (performance.now() - t0 > TIME_BUDGET_MS) { partial = true; return; }
      const f = await readFile(b.pathname);
      if (!f) return;
      const buffer = Buffer.from(await new Response(f.stream).arrayBuffer());
      await bWrite(b.pathname, buffer, f.contentType || "application/octet-stream");
      proofs[b.pathname] = { size: buffer.length, etag: b.etag };
      copied++;
    });
    const expired = [];
    for (const [pathname, p] of Object.entries(proofs)) {
      if (seen.has(pathname)) continue;
      if (!p.missingSince) p.missingSince = at;
      else if (now - Date.parse(p.missingSince) > KEEP_PROOF_DAYS * 86_400_000) expired.push(pathname);
    }
    await bDelete(expired);
    for (const p of expired) delete proofs[p];

    // 4. tonight's state, then drop snapshots older than the last 30
    await bWrite("state.json", JSON.stringify({ version: 1, lastSnapshot: snapshotPath, etags, proofs, updatedAt: at }), "application/json");
    const snapshots = (await bList("snapshots/")).map((b) => b.pathname).sort();
    const old = snapshots.slice(0, Math.max(0, snapshots.length - KEEP_SNAPSHOTS)).filter((p) => p !== snapshotPath);
    await bDelete(old);

    const summary = {
      ok: true, at, by, snapshot: snapshotPath, verified: true, partial,
      documents: Object.keys(docs).length, bookings: countOf(docs, "bookings/"), changed: fetched, unchanged: reused,
      receipts: Object.keys(proofs).length, receiptsCopied: copied, receiptsDropped: expired.length,
      snapshotsKept: snapshots.length - old.length, snapshotsDropped: old.length, bytes: body.length, tookMs: Math.round(performance.now() - t0),
    };
    await saveStatus(summary);
    return summary;
  } catch (err) {
    const summary = { ok: false, at, by, reason: "failed", message: plainError(err), tookMs: Math.round(performance.now() - t0) };
    console.error(`Backup failed: ${summary.message}`);
    await saveStatus(summary);
    return summary;
  }
}

// A copy the owner can keep on their own device: the studio's records only (no logins, no receipts).
export async function exportStudioData({ now = Date.now() } = {}) {
  const blobs = (await listAll("")).filter((b) => isStudioDoc(b.pathname));
  const docs = {};
  await mapLimit(blobs, 8, async (b) => {
    const text = await readText(b.pathname);
    if (text !== null) docs[b.pathname] = text;
  });
  return { version: 1, kind: "export", takenAt: new Date(now).toISOString(), note: "Studio records only: settings, bookings and calendar days. Logins and receipt photos are not in this file.", docs: sorted(docs) };
}

// ---------- the way back ----------

export async function listSnapshots() {
  return (await bList("snapshots/")).map((b) => ({ pathname: b.pathname, date: b.pathname.slice(10, 20), size: b.size })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// which: "latest" or a date (YYYY-MM-DD) from the backup store, or an already parsed snapshot / export file.
export async function loadSnapshot(which = "latest") {
  if (which && typeof which === "object") return which;
  let date = which;
  if (which === "latest") {
    const all = await listSnapshots();
    if (!all.length) throw new Error("There are no snapshots in the backup store yet.");
    date = all[all.length - 1].date;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`"${which}" is not a date like 2026-10-24`);
  const snap = await bReadJson(`snapshots/${date}.json`);
  if (!snap) throw new Error(`There is no snapshot for ${date}.`);
  return snap;
}

// Is this copy whole? Every document must read as JSON, and every booking that has a receipt must have its photo
// in the backup store. Needs only the backup store.
export async function checkSnapshot(snapshot) {
  const unreadable = [];
  const bookings = [];
  for (const [pathname, text] of Object.entries(snapshot.docs)) {
    try {
      const doc = JSON.parse(text);
      if (pathname.startsWith("bookings/")) bookings.push(doc);
    } catch {
      unreadable.push(pathname);
    }
  }
  const have = new Set(backupConfigured() ? (await bList("proofs/")).map((b) => b.pathname) : []);
  const withReceipt = bookings.filter((b) => b.hasReceipt);
  return {
    takenAt: snapshot.takenAt,
    documents: Object.keys(snapshot.docs).length,
    bookings: bookings.length,
    unreadable: unreadable.sort(),
    receiptsExpected: withReceipt.length,
    receiptsMissing: withReceipt.map((b) => `proofs/${b.id}`).filter((p) => !have.has(p)).sort(),
  };
}

const wanted = (pathname, only) => !only?.length || only.some((p) => pathname === p || pathname.startsWith(p));

// What restoring would change, without changing anything.
export async function planRestore(snapshot, { only = [], receipts = false } = {}) {
  const live = new Map((await listAll("")).map((b) => [b.pathname, b]));
  const fresh = [];
  const changed = [];
  let same = 0;
  await mapLimit(Object.entries(snapshot.docs).filter(([p]) => wanted(p, only)), 8, async ([pathname, text]) => {
    if (!live.has(pathname)) return fresh.push(pathname);
    const now = await readText(pathname);
    if (now === text) same++;
    else changed.push(pathname);
  });
  const onlyLive = [...live.keys()].filter((p) => isCopiedDoc(p) && wanted(p, only) && !(p in snapshot.docs));
  const missingReceipts = [];
  if (receipts && backupConfigured()) {
    for (const b of await bList("proofs/")) if (!live.has(b.pathname) && wanted(b.pathname, only)) missingReceipts.push(b.pathname);
  }
  return { takenAt: snapshot.takenAt, fresh: fresh.sort(), changed: changed.sort(), same, onlyLive: onlyLive.sort(), missingReceipts: missingReceipts.sort() };
}

// Puts the documents back (new ones and changed ones). `prune` also removes live documents the snapshot does not have.
export async function applyRestore(snapshot, plan, { prune = false } = {}) {
  const write = [...plan.fresh, ...plan.changed];
  await mapLimit(write, 6, (pathname) => writeFile(pathname, Buffer.from(snapshot.docs[pathname], "utf8"), "application/json"));
  let receipts = 0;
  await mapLimit(plan.missingReceipts, 4, async (pathname) => {
    const r = await bRead(pathname);
    if (!r) return;
    await writeFile(pathname, r.buffer, r.contentType || "application/octet-stream");
    receipts++;
  });
  let pruned = 0;
  if (prune) {
    for (const pathname of plan.onlyLive) { await remove(pathname); pruned++; }
  }
  return { written: write.length, receipts, pruned };
}
