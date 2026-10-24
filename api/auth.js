// /api/auth: GET checks the session, POST signs in, DELETE signs out.
//   POST { username, password }   (username is ignored until logins have been set up)
import {
  LEGACY_USER, clearedCookie, getSession, passwordMatches, recoveryConfigured, sessionCookie,
} from "./_lib/auth.js";
import { HttpError, handle, json, readJsonBody, requireSameOrigin, sleep } from "./_lib/http.js";
import { burnTime, loadUsers, normalizeUsername, publicUser, verifyPassword } from "./_lib/users.js";

export function GET(request) {
  return handle(request, ["GET"], async () => {
    const [user, list] = await Promise.all([getSession(request), loadUsers()]);
    return json({ owner: !!user, accounts: !!list, user: user ? publicUser(user) : null });
  });
}

export function POST(request) {
  return handle(request, ["POST"], async () => {
    requireSameOrigin(request);
    const body = await readJsonBody(request, 2_000);
    const password = typeof body.password === "string" ? body.password : "";
    const list = await loadUsers();

    // Nobody has a login yet: the one shared password, as before.
    if (!list) {
      if (!passwordMatches(password)) {
        await sleep(900); // slows down guessing
        throw new HttpError(401, "wrong_password", "That password isn't right.");
      }
      return json({ owner: true, accounts: false, user: publicUser(LEGACY_USER) }, 200, { "Set-Cookie": sessionCookie(LEGACY_USER) });
    }

    const username = normalizeUsername(body.username);
    const user = list.users.find((u) => u.username === username);
    let ok = false;
    let recovery = false;
    if (user) ok = await verifyPassword(password, user.hash);
    else await burnTime(password);
    // Recovery: the site password opens any admin login, so a forgotten admin password isn't a lock-out.
    if (!ok && user?.role === "admin" && recoveryConfigured()) ok = recovery = passwordMatches(password);
    if (!ok) {
      await sleep(900);
      throw new HttpError(401, "wrong_password", "That username or password isn't right.");
    }
    return json(
      { owner: true, accounts: true, user: publicUser(recovery ? { ...user, mustChange: false } : user) },
      200,
      { "Set-Cookie": sessionCookie(user, { recovery }) },
    );
  });
}

export function DELETE(request) {
  return handle(request, ["DELETE"], async () => {
    requireSameOrigin(request);
    return json({ owner: false }, 200, { "Set-Cookie": clearedCookie() });
  });
}
