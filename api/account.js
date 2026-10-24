// /api/account (signed-in logins only)
//   GET   -> { me, users? }            users is only sent to a login that manages logins
//   POST  -> { action, ... }
//     change-password  { current, next }       your own password; ends your other sessions
//     sign-out-others  {}                      ends your other sessions
//     add              { name, username, password, role?, mustChange? }   (admin)
//     reset            { id, password, mustChange? }   (admin) the login must choose its own password again
//     remove           { id }                  (admin) not yourself
//     setup            { users: [...] }        (the single shared password only) creates the first logins
import { requireOwner, sessionCookie } from "./_lib/auth.js";
import { HttpError, handle, json, readJsonBody, requireSameOrigin, sleep } from "./_lib/http.js";
import {
  MAX_USERS, buildUser, checkNewPassword, hashPassword, loadUsers, publicUser, saveUsers, updateUsers, verifyPassword,
} from "./_lib/users.js";

const bad = (message, field) => new HttpError(400, "invalid", message, field);
const forbidden = () => new HttpError(403, "forbidden", "Only a login that manages logins can do that.");
const needAccounts = () => new HttpError(409, "legacy", "Logins haven't been set up yet.");

const USER_ID_RE = /^u[A-Za-z0-9_-]{6,20}$/;
const needUserId = (body) => {
  if (!USER_ID_RE.test(body.id || "")) throw bad("That login isn't valid.");
  return body.id;
};

export function GET(request) {
  return handle(request, ["GET"], async () => {
    const me = await requireOwner(request, { allowMustChange: true });
    const list = await loadUsers();
    return json({
      me: publicUser(me),
      accounts: !!list,
      ...(list && me.role === "admin" ? { users: list.users.map(publicUser) } : {}),
    });
  });
}

export function POST(request) {
  return handle(request, ["POST"], async () => {
    const me = await requireOwner(request, { allowMustChange: true });
    requireSameOrigin(request);
    const body = await readJsonBody(request, 8_000);

    switch (body.action) {
      case "change-password": {
        if (me.legacy) throw needAccounts();
        const current = typeof body.current === "string" ? body.current : "";
        if (!(await verifyPassword(current, me.hash))) {
          await sleep(900);
          throw bad("That isn't your current password.", "current");
        }
        const next = checkNewPassword(body.next, { username: me.username });
        if (next === current) throw bad("Choose a different password from your current one.", "next");
        const hash = await hashPassword(next);
        const updated = await updateUsers((users) => {
          const u = users.find((x) => x.id === me.id);
          if (!u) throw new HttpError(401, "unauthorized", "Please sign in.");
          Object.assign(u, { hash, mustChange: false, sessionVersion: (u.sessionVersion ?? 0) + 1, passwordChangedAt: new Date().toISOString() });
          return u;
        });
        // every other session of this login ends; this one carries on
        return json({ user: publicUser(updated) }, 200, { "Set-Cookie": sessionCookie(updated) });
      }

      case "sign-out-others": {
        if (me.legacy) throw needAccounts();
        const updated = await updateUsers((users) => {
          const u = users.find((x) => x.id === me.id);
          if (!u) throw new HttpError(401, "unauthorized", "Please sign in.");
          u.sessionVersion = (u.sessionVersion ?? 0) + 1;
          return u;
        });
        return json({ user: publicUser(updated) }, 200, { "Set-Cookie": sessionCookie(updated) });
      }

      case "add": {
        if (me.legacy) throw needAccounts();
        if (me.role !== "admin" || me.mustChange) throw forbidden();
        const user = await updateUsers(async (users) => {
          if (users.length >= MAX_USERS) throw bad(`That's the most logins (${MAX_USERS}).`);
          const u = await buildUser(body, users);
          users.push(u);
          return u;
        });
        return json({ user: publicUser(user) });
      }

      case "reset": {
        if (me.legacy) throw needAccounts();
        if (me.role !== "admin" || me.mustChange) throw forbidden();
        const id = needUserId(body);
        const target = (await loadUsers())?.users.find((u) => u.id === id);
        if (!target) throw new HttpError(404, "not_found", "That login no longer exists.");
        const password = checkNewPassword(body.password, { username: target.username, field: "password" });
        const hash = await hashPassword(password);
        const updated = await updateUsers((users) => {
          const u = users.find((x) => x.id === id);
          if (!u) throw new HttpError(404, "not_found", "That login no longer exists.");
          Object.assign(u, {
            hash,
            mustChange: body.mustChange === true || u.id !== me.id, // someone else's reset is a temporary password; your own is yours to keep unless you ask to be made to change it
            sessionVersion: (u.sessionVersion ?? 0) + 1,
            passwordChangedAt: new Date().toISOString(),
          });
          return u;
        });
        return json({ user: publicUser(updated) }, 200, updated.id === me.id ? { "Set-Cookie": sessionCookie(updated) } : {});
      }

      case "remove": {
        if (me.legacy) throw needAccounts();
        if (me.role !== "admin" || me.mustChange) throw forbidden();
        const id = needUserId(body);
        if (id === me.id) throw bad("You can't remove the login you're signed in with.");
        await updateUsers((users) => {
          const i = users.findIndex((u) => u.id === id);
          if (i < 0) throw new HttpError(404, "not_found", "That login no longer exists.");
          users.splice(i, 1);
        });
        return json({ removed: true });
      }

      case "setup": {
        if (!me.legacy) throw new HttpError(409, "already_set_up", "Logins are already set up.");
        const input = Array.isArray(body.users) ? body.users : [];
        if (input.length < 1 || input.length > MAX_USERS) throw bad("Add between 1 and 10 logins.");
        const users = [];
        for (const raw of input) users.push(await buildUser(raw, users));
        if (!users.some((u) => u.role === "admin")) throw bad("At least one login has to manage logins.");
        await saveUsers(users, "create");
        return json({ users: users.map(publicUser) });
      }

      default:
        throw new HttpError(400, "invalid", "Unknown action.");
    }
  });
}
