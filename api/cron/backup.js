// GET or POST /api/cron/backup: runs the backup now (the same one the daily job runs). Same secret as the daily
// job. It has no schedule of its own; it is here so a backup can be started on demand.
import { handle, json } from "../_lib/http.js";
import { authorised, nightlyBackup, originOf } from "../_lib/cron.js";

async function run(request) {
  authorised(request);
  const backup = await nightlyBackup(originOf(request));
  console.log(JSON.stringify({ event: "backup-run", ...backup }));
  return json(backup);
}

export const GET = (request) => handle(request, ["GET"], () => run(request));
export const POST = (request) => handle(request, ["POST"], () => run(request));
