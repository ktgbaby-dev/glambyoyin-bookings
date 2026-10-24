// Private Vercel Blob storage. Layout:
//   settings.json          studio settings (defaults live in settings.js)
//   days/YYYY-MM-DD.json   { entries: [{ id, time, mins }] }: active bookings, the
//                          single source of truth for availability
//   bookings/<id>.json     full booking record
//   proofs/<id>            receipt image
import { put, get, del, list, BlobNotFoundError } from "@vercel/blob";

const ACCESS = "private";
const BASE = { access: ACCESS, addRandomSuffix: false, cacheControlMaxAge: 60 };

async function getBlob(pathname) {
  try {
    // useCache:false reads from origin, so a write is visible to the very next read.
    const res = await get(pathname, { access: ACCESS, useCache: false });
    if (!res || res.statusCode !== 200 || !res.stream) return null;
    return res;
  } catch (err) {
    if (err instanceof BlobNotFoundError) return null;
    throw err;
  }
}

export async function readJson(pathname) {
  const res = await getBlob(pathname);
  if (!res) return null;
  const text = await new Response(res.stream).text();
  return { data: JSON.parse(text), etag: res.blob.etag };
}

// mode: "overwrite" (default) | { ifMatch: etag } | "create" (fails if it exists)
export function writeJson(pathname, data, mode = "overwrite") {
  const opts = { ...BASE, contentType: "application/json" };
  if (mode === "create") opts.allowOverwrite = false;
  else if (mode && mode.ifMatch) opts.ifMatch = mode.ifMatch; // never combine with allowOverwrite:false
  else opts.allowOverwrite = true;
  return put(pathname, JSON.stringify(data), opts);
}

export function writeFile(pathname, buffer, contentType) {
  return put(pathname, buffer, { ...BASE, contentType, allowOverwrite: true });
}

export async function readFile(pathname) {
  const res = await getBlob(pathname);
  if (!res) return null;
  return { stream: res.stream, contentType: res.blob.contentType, size: res.blob.size };
}

export async function remove(pathname) {
  try {
    await del(pathname);
  } catch (err) {
    if (!(err instanceof BlobNotFoundError)) throw err;
  }
}

export async function listAll(prefix) {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

// Runs fn over items with at most `limit` in flight.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
