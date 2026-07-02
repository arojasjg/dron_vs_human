// Multiplayer relay + static host. In production (Render) this ONE process serves the built client
// (dist/) over HTTP and runs the WebSocket relay on the SAME port, so the browser reaches the relay
// same-origin (wss://<host>) with no cross-origin/port config. Locally, run `npm run dev` for the
// client and `npm run relay` for just the WS hub (dist/ may be absent — HTTP then 404s, which is fine).
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT) || 8787;
const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".map": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
};

// --- HTTP: serve the built client from dist/ (SPA fallback to index.html for extension-less routes) ---
const server = createServer(async (req, res) => {
  let path = decodeURIComponent((req.url || "/").split("?")[0]);
  if (path === "/") path = "/index.html";
  const file = normalize(join(DIST, path));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end("forbidden"); return; } // path-traversal guard
  try {
    const body = await readFile(file);
    const ext = extname(file);
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000",
    });
    res.end(body);
  } catch {
    if (!extname(path)) { // no extension → SPA route → index.html; a missing asset is a real 404
      try { res.writeHead(200, { "content-type": MIME[".html"] }); res.end(await readFile(join(DIST, "index.html"))); return; } catch { /* no build */ }
    }
    res.writeHead(404); res.end("not found");
  }
});

// --- WebSocket relay on the SAME server: fan out each room's messages, tagging the sender id ---
const wss = new WebSocketServer({ server });
const rooms = new Map(); // room -> Set<ws>
let nextId = 1;

function broadcast(room, except, str) {
  const set = rooms.get(room);
  if (!set) return;
  for (const c of set) if (c !== except && c.readyState === 1) c.send(str);
}

wss.on("connection", (ws, req) => {
  const room = (new URL(req.url, "http://x").searchParams.get("room") || "lobby").slice(0, 32);
  const id = nextId++;
  ws.cid = id;
  ws.room = room;
  let set = rooms.get(room);
  if (!set) { set = new Set(); rooms.set(room, set); }
  set.add(ws);

  ws.send(JSON.stringify({ t: "hello", id, peers: [...set].filter((c) => c !== ws).map((c) => c.cid) }));
  broadcast(room, ws, JSON.stringify({ t: "join", id }));

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(typeof data === "string" ? data : data.toString()); } catch { return; }
    msg.id = id; // stamp the sender so peers know who it's from
    broadcast(room, ws, JSON.stringify(msg));
  });

  ws.on("close", () => {
    set.delete(ws);
    broadcast(room, ws, JSON.stringify({ t: "leave", id }));
    if (set.size === 0) rooms.delete(room);
  });
});

server.listen(PORT, () => console.log(`[relay+static] http + ws on :${PORT}  (serving ${DIST})`));
