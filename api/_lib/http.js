// Small helpers shared by the api/ functions (Web Request/Response handlers).

export class HttpError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export function fail(status, code, message, headers) {
  return json({ error: code, message }, status, headers);
}

// Wraps a handler so thrown HttpErrors become JSON errors and anything else
// becomes a generic 500 (logged, never leaked to the client).
export async function handle(request, allowed, fn) {
  try {
    if (!allowed.includes(request.method)) {
      return fail(405, "method_not_allowed", "Method not allowed.", { Allow: allowed.join(", ") });
    }
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) }, err.status);
    }
    console.error(err);
    return fail(500, "server_error", "Something went wrong on our side. Please try again.");
  }
}

// Reads a JSON body. Requiring application/json means a cross-site HTML form
// can't post here without a CORS preflight (CSRF guard alongside SameSite=Lax).
export async function readJsonBody(request, maxBytes) {
  const type = request.headers.get("content-type") || "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Send the request as JSON.");
  }
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new HttpError(413, "too_large", "That upload is too large.");
  const text = await request.text();
  if (Buffer.byteLength(text) > maxBytes) throw new HttpError(413, "too_large", "That upload is too large.");
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not an object");
    return data;
  } catch {
    throw new HttpError(400, "bad_json", "The request couldn't be read.");
  }
}

// Browsers always send Origin on cross-site POSTs. If it's there and isn't us, refuse.
export function requireSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    host = "";
  }
  const ours = request.headers.get("x-forwarded-host") || request.headers.get("host") || new URL(request.url).host;
  if (host !== ours) throw new HttpError(403, "bad_origin", "That request didn't come from this site.");
}

export function query(request) {
  return new URL(request.url).searchParams;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const ID_RE = /^[A-Za-z0-9_-]{10,32}$/;
