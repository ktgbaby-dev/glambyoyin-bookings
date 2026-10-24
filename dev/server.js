// Local dev server: serves public/ and runs the api/ handlers against the in-memory
// Blob mock (start with: node --import ./dev/register.js dev/server.js).
// Not deployed: .vercelignore excludes dev/.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 5630);

// Dev-only credentials; production uses the real env vars.
process.env.OWNER_PASSWORD ??= "dev-password";
process.env.SESSION_SECRET ??= "dev-session-secret-dev-session-secret";
process.env.CRON_SECRET ??= "dev-cron-secret-dev-cron-secret";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".ttf": "font/ttf", ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function runApi(req, res, name) {
  let mod;
  try {
    mod = await import(pathToFileURL(join(root, "api", `${name}.js`)).href);
  } catch {
    res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not_found"}');
    return;
  }
  const fn = mod[req.method];
  if (!fn) {
    res.writeHead(405, { "Content-Type": "application/json" }).end('{"error":"method_not_allowed"}');
    return;
  }
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? await readBody(req) : undefined,
  });
  const response = await fn(request);
  const headers = {};
  for (const [k, v] of response.headers) if (k !== "set-cookie") headers[k] = v;
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return await runApi(req, res, url.pathname.slice(5).replace(/\/$/, ""));

    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = normalize(join(publicDir, rel));
    if (!file.startsWith(publicDir)) return res.writeHead(403).end();
    await stat(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(await readFile(file));
  } catch (err) {
    if (err.code === "ENOENT") return res.writeHead(404).end("Not found");
    console.error(err);
    res.writeHead(500).end("Server error");
  }
}).listen(port, "127.0.0.1", () => console.log(`GLAM BY OYIN bookings (mock storage) on http://127.0.0.1:${port}`));
