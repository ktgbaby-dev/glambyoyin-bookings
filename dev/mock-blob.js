// In-memory stand-in for @vercel/blob, used only by local dev and tests.
// Mirrors the behaviour the booking code depends on:
//   - writes to an existing blob fail unless allowOverwrite:true or ifMatch matches
//   - ifMatch with a stale/missing ETag throws BlobPreconditionFailedError
//   - ifMatch together with allowOverwrite:false is rejected (as in SDK 2.8.1)
//   - get() returns null for a missing blob and { statusCode, stream, blob:{etag,…} } otherwise
//   - the store is "private": every call must say access: "private"
// A little random latency makes concurrent requests genuinely interleave.

export class BlobError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlobError";
  }
}
export class BlobPreconditionFailedError extends BlobError {
  constructor() {
    super("Precondition failed: ETag mismatch.");
    this.name = "BlobPreconditionFailedError";
  }
}
export class BlobNotFoundError extends BlobError {
  constructor() {
    super("The requested blob does not exist");
    this.name = "BlobNotFoundError";
  }
}

const store = new Map(); // pathname -> { buffer, contentType, etag, uploadedAt }
let version = 0;
const latency = () => new Promise((r) => setTimeout(r, Math.random() * 8));

function requirePrivate(opts, fn) {
  if (!opts || opts.access !== "private") throw new BlobError(`${fn}: this store is private, pass access: "private"`);
}

function toBuffer(body) {
  if (typeof body === "string") return Buffer.from(body);
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new BlobError("Unsupported body type in mock");
}

const describe = (pathname, v) => ({
  url: `https://mock.private.blob.vercel-storage.com/${pathname}`,
  downloadUrl: `https://mock.private.blob.vercel-storage.com/${pathname}?download=1`,
  pathname,
  contentType: v.contentType,
  contentDisposition: "inline",
  etag: v.etag,
});

export async function put(pathname, body, opts = {}) {
  await latency();
  requirePrivate(opts, "put");
  if (opts.ifMatch && opts.allowOverwrite === false) {
    throw new BlobError("ifMatch cannot be combined with allowOverwrite: false");
  }
  const cur = store.get(pathname);
  if (opts.ifMatch) {
    if (!cur || cur.etag !== opts.ifMatch) throw new BlobPreconditionFailedError();
  } else if (cur && !opts.allowOverwrite) {
    throw new BlobError("This blob already exists, set `allowOverwrite: true` to overwrite it.");
  }
  // Check-and-set below is synchronous, so it is atomic just like the real service.
  const v = {
    buffer: toBuffer(body),
    contentType: opts.contentType || "application/octet-stream",
    etag: `"v${++version}"`,
    uploadedAt: new Date(),
  };
  store.set(pathname, v);
  return describe(pathname, v);
}

export async function get(pathname, opts = {}) {
  await latency();
  requirePrivate(opts, "get");
  const v = store.get(pathname);
  if (!v) return null;
  return {
    statusCode: 200,
    stream: new Response(v.buffer).body,
    headers: new Headers({ "content-type": v.contentType }),
    blob: { ...describe(pathname, v), size: v.buffer.length, cacheControl: "", uploadedAt: v.uploadedAt },
  };
}

export async function del(target) {
  await latency();
  for (const t of Array.isArray(target) ? target : [target]) {
    const pathname = t.startsWith("https://") ? new URL(t).pathname.slice(1) : t;
    store.delete(pathname);
  }
}

export async function list({ prefix = "", cursor, limit = 1000 } = {}) {
  await latency();
  const all = [...store.keys()].filter((p) => p.startsWith(prefix)).sort();
  const start = cursor ? Number(cursor) : 0;
  const page = all.slice(start, start + limit);
  const end = start + page.length;
  return {
    blobs: page.map((p) => ({ ...describe(p, store.get(p)), size: store.get(p).buffer.length, uploadedAt: store.get(p).uploadedAt })),
    hasMore: end < all.length,
    cursor: end < all.length ? String(end) : undefined,
  };
}

// Test helpers (not part of the real SDK)
export const __mock = {
  paths: (prefix = "") => [...store.keys()].filter((p) => p.startsWith(prefix)).sort(),
  reset: () => store.clear(),
};
