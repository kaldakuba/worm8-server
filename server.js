// Wörm8 – relay server pro online hru.
// Server nic nepočítá: drží místnosti (kód 4 znaky) a přeposílá zprávy mezi telefony.
// Hostitel (zakladatel místnosti) počítá bitvu, ostatní posílají své tahy.
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 6;
const rooms = new Map(); // code -> {code, host, nextId, locked, players: Map(id -> {id, name, ws})}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("worm8 relay ok, mistnosti: " + rooms.size + "\n");
});
const wss = new WebSocketServer({ server });

function makeCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    let c = "";
    for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
    if (!rooms.has(c)) return c;
  }
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function playerList(room) {
  return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, on: !!p.ws }));
}

function broadcastPlayers(room) {
  const msg = { op: "players", players: playerList(room), host: room.host, locked: room.locked };
  for (const p of room.players.values()) send(p.ws, msg);
}

wss.on("connection", (ws) => {
  ws.alive = true;
  ws.on("pong", () => (ws.alive = true));
  let room = null;
  let me = null;

  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.op === "ping") return send(ws, { op: "pong", t: m.t });

    if (m.op === "create" && !room) {
      let code = makeCode();
      const want = String(m.code || "").toUpperCase();
      if (/^[A-Z0-9]{4}$/.test(want) && !rooms.has(want)) code = want;
      room = { code, host: 1, nextId: 2, locked: false, players: new Map() };
      me = { id: 1, name: String(m.name || "Hráč").slice(0, 20), ws };
      room.players.set(1, me);
      rooms.set(code, room);
      send(ws, { op: "welcome", id: 1, code, host: 1, players: playerList(room) });
      return;
    }

    if (m.op === "join" && !room) {
      const r = rooms.get(String(m.code || "").toUpperCase());
      if (!r) return send(ws, { op: "error", msg: "Hra s tímto kódem neexistuje." });
      const name = String(m.name || "Hráč").slice(0, 20);
      // návrat odpojeného hráče (stejné jméno) – i do rozehrané hry
      let slot = r.locked ? null : [...r.players.values()].find((p) => !p.ws && p.name === name);
      if (slot) {
        slot.ws = ws;
        room = r;
        me = slot;
        send(ws, { op: "welcome", id: me.id, code: r.code, host: r.host, players: playerList(r), rejoin: true });
        send(r.players.get(r.host)?.ws, { op: "rejoin", id: me.id });
        broadcastPlayers(r);
        return;
      }
      if (r.locked) return send(ws, { op: "error", msg: "Hra už běží." });
      if (r.players.size >= MAX_PLAYERS) return send(ws, { op: "error", msg: "Hra je plná (6 hráčů)." });
      room = r;
      me = { id: r.nextId++, name, ws };
      r.players.set(me.id, me);
      send(ws, { op: "welcome", id: me.id, code: r.code, host: r.host, players: playerList(r) });
      broadcastPlayers(r);
      return;
    }

    if (!room) return;

    if (m.op === "lock" && me.id === room.host) {
      room.locked = true;
      broadcastPlayers(room);
      return;
    }

    if (m.op === "kick" && me.id === room.host) {
      const p = room.players.get(m.id);
      if (p) {
        send(p.ws, { op: "error", msg: "Hostitel tě vyřadil." });
        p.ws?.close();
        room.players.delete(m.id);
        broadcastPlayers(room);
      }
      return;
    }

    if (m.op === "send") {
      const out = JSON.stringify({ op: "msg", from: me.id, d: m.d });
      const to = m.to;
      for (const p of room.players.values()) {
        if (!p.ws || p.ws.readyState !== 1) continue;
        if (to === "all" || (to === "others" && p.id !== me.id) || (to === "host" && p.id === room.host) || to === p.id) {
          p.ws.send(out);
        }
      }
    }
  });

  ws.on("close", () => {
    if (!room || !me) return;
    me.ws = null;
    if (me.id === room.host) {
      // hostitel odešel – hra končí
      for (const p of room.players.values()) send(p.ws, { op: "closed" });
      rooms.delete(room.code);
      return;
    }
    if (!room.locked) room.players.delete(me.id);
    send(room.players.get(room.host)?.ws, { op: "left", id: me.id });
    broadcastPlayers(room);
    if ([...room.players.values()].every((p) => !p.ws)) rooms.delete(room.code);
  });
});

// udržování spojení (některé hostingy jinak nečinné spojení zavřou)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log("worm8 relay na portu " + PORT));
