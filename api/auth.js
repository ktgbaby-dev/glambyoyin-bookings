// /api/auth: GET checks the session, POST signs in, DELETE signs out.
import { clearedCookie, isOwner, passwordMatches, sessionCookie } from "./_lib/auth.js";
import { HttpError, handle, json, readJsonBody, requireSameOrigin, sleep } from "./_lib/http.js";

export function GET(request) {
  return handle(request, ["GET"], async () => json({ owner: isOwner(request) }));
}

export function POST(request) {
  return handle(request, ["POST"], async () => {
    requireSameOrigin(request);
    const { password } = await readJsonBody(request, 2_000);
    if (!passwordMatches(typeof password === "string" ? password : "")) {
      await sleep(900); // slows down guessing
      throw new HttpError(401, "wrong_password", "That password isn't right.");
    }
    return json({ owner: true }, 200, { "Set-Cookie": sessionCookie() });
  });
}

export function DELETE(request) {
  return handle(request, ["DELETE"], async () => {
    requireSameOrigin(request);
    return json({ owner: false }, 200, { "Set-Cookie": clearedCookie() });
  });
}
