// Puts bookings back from a backup. Runs on a computer, not on the site.
//
//   node dev/restore.mjs list                          the nightly copies in the backup store
//   node dev/restore.mjs check latest                  is the newest copy whole? (needs only the backup store token)
//   node dev/restore.mjs plan  latest                  what restoring the newest copy would change (changes nothing)
//   node dev/restore.mjs plan  2026-10-24 --receipts   the same for one night, including missing receipt photos
//   node dev/restore.mjs plan  --file records.json     from a file saved with "Download a copy" on the desk
//   node dev/restore.mjs apply latest --only bookings/AbC123.json --only days/2026-10-30.json
//                                                      really restores, but only those documents
//
// Needs two environment variables (Vercel, Storage, each store, ".env.local" tab):
//   BLOB_READ_WRITE_TOKEN          the main store
//   BACKUP_BLOB_READ_WRITE_TOKEN   the backup store
//
// "plan" never writes. "apply" first saves what is live to restore-safety-<time>.json next to where you ran it, then
// writes the documents that are new or different. Documents that exist only in the main store are left alone
// unless you add --prune. Add --receipts to copy receipt photos that are missing from the main store.
import { readFileSync, writeFileSync } from "node:fs";
import { applyRestore, backupConfigured, checkSnapshot, listSnapshots, loadSnapshot, planRestore } from "../api/_lib/backup.js";
import { listAll, readFile } from "../api/_lib/store.js";

const args = process.argv.slice(2);
const command = args.shift();
const flag = (name) => args.includes(name);
const values = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--only" && args[i - 1] !== "--file") || "latest";

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!["list", "check", "plan", "apply"].includes(command)) fail(`Usage: node dev/restore.mjs list | check [latest|DATE] | plan [latest|DATE|--file F] | apply [latest|DATE|--file F] [--only PATH ...] [--receipts] [--prune]`);
if (["plan", "apply"].includes(command) && !process.env.BLOB_READ_WRITE_TOKEN) fail("BLOB_READ_WRITE_TOKEN (the main store) is not set.");
if (!backupConfigured() && !values("--file").length) fail("BACKUP_BLOB_READ_WRITE_TOKEN (the backup store) is not set.");

if (command === "list") {
  const all = await listSnapshots();
  if (!all.length) console.log("There are no copies in the backup store yet.");
  for (const s of all) console.log(`${s.date}  ${Math.round(s.size / 1024)} KB`);
  process.exit(0);
}

if (command === "check") {
  const r = await checkSnapshot(await loadSnapshot(target));
  console.log(`Copy taken ${r.takenAt}: ${r.documents} documents, ${r.bookings} bookings, ${r.receiptsExpected} receipts expected`);
  console.log(`  unreadable documents   ${r.unreadable.length}${r.unreadable.length ? "  " + r.unreadable.join(", ") : ""}`);
  console.log(`  receipts missing       ${r.receiptsMissing.length}${r.receiptsMissing.length ? "  " + r.receiptsMissing.join(", ") : ""}`);
  const ok = !r.unreadable.length && !r.receiptsMissing.length;
  console.log(ok ? "This copy is whole." : "This copy has problems.");
  process.exit(ok ? 0 : 1);
}

const file = values("--file")[0];
const snapshot = file ? JSON.parse(readFileSync(file, "utf8")) : await loadSnapshot(target);
if (!snapshot?.docs) fail("That file is not a backup.");
const only = values("--only");
const receipts = flag("--receipts");
const plan = await planRestore(snapshot, { only, receipts });

console.log(`Backup taken ${snapshot.takenAt} (${Object.keys(snapshot.docs).length} documents${snapshot.kind === "export" ? ", a downloaded copy: no logins or receipts" : ""})`);
console.log(`  would add      ${plan.fresh.length}`);
for (const p of plan.fresh.slice(0, 40)) console.log(`    + ${p}`);
console.log(`  would change   ${plan.changed.length}`);
for (const p of plan.changed.slice(0, 40)) console.log(`    ~ ${p}`);
console.log(`  already same   ${plan.same}`);
console.log(`  only in the live store (left alone${flag("--prune") ? ", will be REMOVED" : ""})   ${plan.onlyLive.length}`);
for (const p of plan.onlyLive.slice(0, 40)) console.log(`    - ${p}`);
if (receipts) console.log(`  receipts missing from the live store   ${plan.missingReceipts.length}`);

if (command === "plan") {
  console.log("\nNothing was changed. Add --apply (use the apply command) to restore.");
  process.exit(0);
}

// apply: keep what is live first
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const keep = {};
for (const b of (await listAll("")).filter((x) => !x.pathname.startsWith("proofs/") && !x.pathname.startsWith("rl/"))) {
  const f = await readFile(b.pathname);
  if (f) keep[b.pathname] = await new Response(f.stream).text();
}
const safety = `restore-safety-${stamp}.json`;
writeFileSync(safety, JSON.stringify({ version: 1, kind: "snapshot", takenAt: new Date().toISOString(), docs: keep }));
console.log(`\nWhat was live is saved in ${safety}`);
const done = await applyRestore(snapshot, plan, { prune: flag("--prune") });
console.log(`Restored: ${done.written} documents, ${done.receipts} receipt photos${flag("--prune") ? `, removed ${done.pruned}` : ""}.`);
