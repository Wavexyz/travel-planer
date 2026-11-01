#!/usr/bin/env node
/**
 * Tiny static server for the trip site.
 *
 * Why not `python -m http.server`? The map is served as PMTiles archives, and
 * PMTiles needs HTTP Range requests. Python's built-in server ignores Range,
 * so MapLibre would download every 50 MB archive in full. This server supports
 * Range, ETags and the MIME types the map needs.
 *
 *   npm start            → http://127.0.0.1:4173 (opens your browser)
 *   npm start -- --no-open
 *   PORT=8080 npm start
 */
import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const START_PORT = Number(process.env.PORT) || 4173;
const OPEN = !process.argv.includes("--no-open") && process.env.NO_OPEN !== "1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".pbf": "application/x-protobuf",
  ".pmtiles": "application/octet-stream",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};
const LONG_CACHE = /^\/(img|tiles|fonts|sprites|vendor)\//;

/* Minimal valid MapLibre glyph PBF with no glyphs, used when a range is not
   shipped. Keeps the map quiet instead of logging 404s for exotic codepoints. */
function varint(n) {
  const out = [];
  while (n > 127) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}
function lenField(field, buf) {
  return Buffer.concat([Buffer.from([(field << 3) | 2]), varint(buf.length), buf]);
}
function emptyGlyphPbf(range) {
  const stack = Buffer.concat([lenField(1, Buffer.from("Sans Regular")), lenField(2, Buffer.from(range))]);
  return Buffer.concat([lenField(1, stack)]);
}
function glyphFallback(urlPath) {
  const m = /^\/fonts\/noto-(?:regular|medium|italic)-(\d+)-(\d+)\.pbf$/.exec(urlPath);
  if (!m) return null;
  return emptyGlyphPbf(`${m[1]}-${m[2]}`);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return false;
  const [, a, b] = m;
  if (a === "" && b === "") return false;
  if (a === "") {
    const suffix = Number(b);
    if (!Number.isFinite(suffix) || suffix <= 0) return false;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(a);
  const end = b === "" ? size - 1 : Number(b);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return false;
  return { start, end: Math.min(end, size - 1) };
}

async function resolveFile(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  if (p.includes("\0")) return null;
  if (p === "/" || p === "") p = "/index.html";
  if (p.endsWith("/")) p += "index.html";
  const abs = path.resolve(ROOT, "." + p);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  if (path.basename(abs).startsWith(".DS_Store")) return null;
  try {
    const s = await stat(abs);
    if (s.isDirectory()) {
      const index = path.join(abs, "index.html");
      const si = await stat(index);
      return { abs: index, size: si.size, mtime: si.mtimeMs };
    }
    if (!s.isFile()) return null;
    return { abs, size: s.size, mtime: s.mtimeMs };
  } catch { return null; }
}

async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
  }
  const urlPath = new URL(req.url, "http://localhost").pathname;
  const file = await resolveFile(urlPath);
  if (!file) {
    const glyph = glyphFallback(urlPath);
    if (glyph) {
      res.writeHead(200, {
        "Content-Type": "application/x-protobuf",
        "Content-Length": glyph.length,
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      });
      return req.method === "HEAD" ? res.end() : res.end(glyph);
    }
    return send(res, 404, "Not found");
  }

  const ext = path.extname(file.abs).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const etag = `"${file.size.toString(16)}-${Math.round(file.mtime).toString(16)}"`;
  const baseHeaders = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    ETag: etag,
    "Last-Modified": new Date(file.mtime).toUTCString(),
    "Cache-Control": LONG_CACHE.test(urlPath) ? "public, max-age=86400" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  };

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, baseHeaders);
    return res.end();
  }

  const range = parseRange(req.headers.range, file.size);
  if (range === false) {
    res.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${file.size}` });
    return res.end();
  }
  if (range) {
    const length = range.end - range.start + 1;
    res.writeHead(206, {
      ...baseHeaders,
      "Content-Range": `bytes ${range.start}-${range.end}/${file.size}`,
      "Content-Length": length,
    });
    if (req.method === "HEAD") return res.end();
    const stream = createReadStream(file.abs, { start: range.start, end: range.end });
    stream.on("error", () => res.destroy());
    return stream.pipe(res);
  }

  res.writeHead(200, { ...baseHeaders, "Content-Length": file.size });
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(file.abs);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

function openBrowser(url) {
  if (!OPEN) return;
  const cmd = process.platform === "darwin" ? `open "${url}"`
    : process.platform === "win32" ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function listen(port, attempts = 12) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handler(req, res).catch(err => {
        console.error(err);
        if (!res.headersSent) send(res, 500, "Server error");
        else res.destroy();
      });
    });
    server.once("error", err => {
      if (err.code === "EADDRINUSE" && attempts > 0) {
        listen(port + 1, attempts - 1).then(resolve, reject);
      } else reject(err);
    });
    server.listen(port, HOST, () => resolve(server));
  });
}

const server = await listen(START_PORT);
const port = server.address().port;
const url = `http://${HOST}:${port}/`;
console.log(`\n  Japan in Autumn\n  ${url}\n  Serving ${ROOT}\n  Press Ctrl+C to stop.\n`);
openBrowser(url);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}
