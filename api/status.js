// GET /api/status?id=&code=: a client checks their own booking. A wrong code
// looks exactly like a missing booking.
import { clientView, codeMatches } from "./_lib/bookings.js";
import { HttpError, ID_RE, handle, json, query } from "./_lib/http.js";
import { readJson } from "./_lib/store.js";

export function GET(request) {
  return handle(request, ["GET"], async () => {
    const q = query(request);
    const id = q.get("id") || "";
    const code = q.get("code") || "";
    const notFound = new HttpError(404, "not_found", "We couldn't find that booking.");
    if (!ID_RE.test(id) || !code) throw notFound;

    const file = await readJson(`bookings/${id}.json`);
    if (!file || !codeMatches(file.data.code, code)) throw notFound;
    return json({ booking: clientView(file.data) });
  });
}
