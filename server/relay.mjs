// Multiplayer relay: a tiny authoritative-less WebSocket hub. Every client joins a room (?room=)
// and the server fans out each message to the other clients in that room, tagging the sender id.
// Run locally with `npm run relay`; host it (Render/Railway/Fly/VPS) for play over the internet.
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 8787;
const wss = new WebSocketServer({ port: PORT });
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

console.log(`[relay] listening on ws://localhost:${PORT}  (rooms fan-out)`);
