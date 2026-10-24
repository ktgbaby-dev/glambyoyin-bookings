// GET /api/public: studio settings plus taken slots for the next 21 days.
// No client details, only {date, time, mins}.
import { DAYS_AHEAD } from "./_lib/bookings.js";
import { handle, json } from "./_lib/http.js";
import { loadSettings, publicSettings } from "./_lib/settings.js";
import { mapLimit, readJson } from "./_lib/store.js";
import { addDays, dateInTz } from "./_lib/time.js";

export function GET(request) {
  return handle(request, ["GET"], async () => {
    const settings = await loadSettings();
    const now = Date.now();
    const today = dateInTz(now, settings.tz);
    const dates = Array.from({ length: DAYS_AHEAD }, (_, i) => addDays(today, i));

    const days = await mapLimit(dates, 7, async (date) => ({ date, file: await readJson(`days/${date}.json`) }));
    const taken = [];
    for (const { date, file } of days) {
      for (const e of file?.data.entries ?? []) taken.push({ date, time: e.time, mins: e.mins });
    }

    return json({ settings: publicSettings(settings), taken, now, today });
  });
}
