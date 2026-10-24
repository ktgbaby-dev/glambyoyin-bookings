// Module loader hook: redirects "@vercel/blob" to the in-memory mock.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@vercel/blob") {
    return { url: new URL("./mock-blob.js", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
