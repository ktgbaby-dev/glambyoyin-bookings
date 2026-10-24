// Studio logins: users.json in the private Blob store. Passwords are never kept,
// only a salted scrypt hash. Until users.json exists the site runs in "legacy"
// mode: a single shared password in OWNER_PASSWORD (see auth.js).
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { BlobPreconditionFailedError } from "@vercel/blob";
import { HttpError } from "./http.js";
import { readJson, writeJson } from "./store.js";

const scrypt = promisify(scryptCb);
const PATH = "users.json";
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
export const MAX_USERS = 10;
export const MIN_PASSWORD = 10;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const [alg, n, r, p, salt, key] = String(stored || "").split("$");
  if (alg !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const got = await scrypt(String(password ?? ""), Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// A wrong username should cost as much time as a wrong password.
let dummy;
export async function burnTime(password) {
  dummy ??= await hashPassword("not-a-real-password");
  await verifyPassword(password, dummy);
}

const bad = (message, field) => new HttpError(400, "invalid", message, field);

const COMMON = ["password", "123456", "qwerty", "letmein", "welcome", "iloveyou", "glambyoyin"];

// `field` is the form field an error belongs to ("next" when changing a password, "password" when setting one for someone).
export function checkNewPassword(password, { username = "", field = "next" } = {}) {
  const s = typeof password === "string" ? password : "";
  if (s.length < MIN_PASSWORD) throw bad(`Use at least ${MIN_PASSWORD} characters.`, field);
  if (s.length > 128) throw bad("That password is too long (128 characters at most).", field);
  if (new Set(s).size < 5) throw bad("That password is too simple. Use more different characters.", field);
  const lower = s.toLowerCase();
  if (COMMON.some((w) => lower.includes(w))) throw bad("That password is too easy to guess. Choose something less common.", field);
  if (username.length >= 3 && lower.includes(username.toLowerCase())) throw bad("A password can't contain the username.", field);
  return s;
}

export const normalizeUsername = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export const newUserId = () => "u" + randomBytes(8).toString("base64url");

// What the browser may see about a login. Never the hash.
export function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    mustChange: !!u.mustChange,
    createdAt: u.createdAt ?? null,
    passwordChangedAt: u.passwordChangedAt ?? null,
    ...(u.legacy ? { legacy: true } : {}),
  };
}

// { users, etag } or null while the site is still in legacy (single password) mode.
export async function loadUsers() {
  const file = await readJson(PATH);
  return file ? { users: Array.isArray(file.data.users) ? file.data.users : [], etag: file.etag } : null;
}

// mode: "create" for the first write, or { ifMatch: etag } to change what we just read.
export async function saveUsers(users, mode) {
  try {
    await writeJson(PATH, { users }, mode);
  } catch (err) {
    if (err instanceof BlobPreconditionFailedError || mode === "create") {
      throw new HttpError(409, "changed", "The logins were just changed by someone else. Please try again.");
    }
    throw err;
  }
}

// Read, change, write back (refused if someone else wrote in between).
export async function updateUsers(fn) {
  const list = await loadUsers();
  if (!list) throw new HttpError(409, "legacy", "Logins haven't been set up yet.");
  const users = structuredClone(list.users);
  const result = await fn(users);
  await saveUsers(users, { ifMatch: list.etag });
  return result;
}

// Fields for a new login, checked.
export async function buildUser(input, existing) {
  const name = typeof input?.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
  if (name.length < 1 || name.length > 60) throw bad("Add a name (up to 60 characters).", "name");
  const username = normalizeUsername(input?.username);
  if (!USERNAME_RE.test(username)) throw bad("Usernames are 3 to 32 letters, numbers, dots, dashes or underscores.", "username");
  if (existing.some((u) => u.username === username)) throw bad("That username is already taken.", "username");
  const role = input?.role === "admin" ? "admin" : "member";
  const password = checkNewPassword(input?.password, { username, field: "password" });
  return {
    id: newUserId(),
    username,
    name,
    role,
    hash: await hashPassword(password),
    mustChange: input?.mustChange !== false,
    sessionVersion: 0,
    createdAt: new Date().toISOString(),
    passwordChangedAt: null,
  };
}
