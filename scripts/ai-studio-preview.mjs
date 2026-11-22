import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const entry = "src/ui/history.html";
const files = new Set([]);
const directories = new Set(["src", "icons"]);
const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".avif": "image/avif", ".gif": "image/gif", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".mp4": "video/mp4", ".wasm": "application/wasm", ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8"
};

createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  let name;
  let query;
  try {
    const url = new URL(req.url, "http://localhost");
    name = decodeURIComponent(url.pathname).slice(1);
    query = url.search;
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (!name && entry.includes("/")) {
    res.writeHead(302, { Location: "/" + entry + query }).end();
    return;
  }
  name ||= entry;
  const parts = name.split("/");
  if (parts.some(part => part.startsWith(".") || part === "node_modules" || /[\\:\x00-\x1f]/.test(part)) ||
      (!files.has(name) && !directories.has(parts[0]))) {
    res.writeHead(404).end();
    return;
  }
  try {
    let filename = path.join(root, name);
    if ((await stat(filename)).isDirectory()) {
      if (!name.endsWith("/")) {
        res.writeHead(302, { Location: "/" + name.split("/").map(encodeURIComponent).join("/") + "/" + query }).end();
        return;
      }
      filename = path.join(filename, "index.html");
    }
    const type = types[path.extname(filename).toLowerCase()];
    if (!type || await realpath(filename) !== filename) {
      res.writeHead(404).end();
      return;
    }
    const info = await stat(filename);
    if (!info.isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": info.size, "Cache-Control": "no-cache" });
    if (req.method === "HEAD") res.end();
    else createReadStream(filename).on("error", () => res.destroy()).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
}).listen(Number(process.env.PORT || 3000), process.env.HOST || "0.0.0.0");
