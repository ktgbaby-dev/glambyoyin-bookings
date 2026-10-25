// GET or POST /api/cron/reminders: the daily job. It is the safety net for appointment reminders (see
// _lib/reminders.js) and it also makes the nightly backup (see _lib/backup.js). Vercel's Hobby plan allows
// one run a day per entry, so both share this one entry in vercel.json.
import { handle, json } from "../_lib/http.js";
import { authorised, nightlyBackup, originOf } from "../_lib/cron.js";
import { reconcile } from "../_lib/reminders.js";

async function run(request) {
  authorised(request);
  const origin = originOf(request);
  const summary = await reconcile({ origin });
  console.log(JSON.stringify({ event: "reminders-run", ...summary }));
  const backup = await nightlyBackup(origin);
  console.log(JSON.stringify({ event: "backup-run", ...backup }));
  return json({ ...summary, backup });
}

export const GET = (request) => handle(request, ["GET"], () => run(request));
export const POST = (request) => handle(request, ["POST"], () => run(request));
