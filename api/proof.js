// GET /api/proof?id= (owner only): streams the receipt image.
import { requireOwner } from "./_lib/auth.js";
import { HttpError, ID_RE, handle, query } from "./_lib/http.js";
import { readFile } from "./_lib/store.js";

export function GET(request) {
  return handle(request, ["GET"], async () => {
    requireOwner(request);
    const id = query(request).get("id") || "";
    if (!ID_RE.test(id)) throw new HttpError(404, "not_found", "No receipt for that booking.");
    const file = await readFile(`proofs/${id}`);
    if (!file) throw new HttpError(404, "not_found", "No receipt for that booking.");
    return new Response(file.stream, {
      headers: {
        "Content-Type": file.contentType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
      },
    });
  });
}
