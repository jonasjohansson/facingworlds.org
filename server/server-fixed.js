const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const PLAYER_HP = 100;
const MAX_NAME = 24;
const POSE_UPDATE_INTERVAL = 100; // ms - throttle pose updates

const players = new Map(); // id -> {id,name,hp,x,y,z,ry}
const clients = new Map(); // ws -> id
const lastPoseUpdate = new Map(); // id -> timestamp

const wss = new WebSocketServer({ port: PORT }, () => console.log(`✅ ws server on :${PORT}`));

const id4 = () => crypto.randomBytes(3).toString("hex");

wss.on("connection", (ws) => {
  const id = id4();
  clients.set(ws, id);

  const p = { id, name: `Player_${id}`, hp: PLAYER_HP, x: 0, y: 0, z: 0, ry: 0 };
  players.set(id, p);

  send(ws, { type: "hello", yourId: id, players: [...players.values()] });
  broadcastExcept(ws, { type: "join", player: p });

  ws.on("message", (buf) => {
    let m;
    try {
      m = JSON.parse(buf.toString());
    } catch {
      return;
    }
    const me = players.get(id);
    if (!me) return;

    switch (m.type) {
      case "setName": {
        const clean =
          String(m.name || "")
            .slice(0, 24)
            .trim() || `Player_${id}`;
        me.name = clean;
        broadcast({ type: "name", id, name: clean });
        break;
      }

      case "spawn": {
        if (m.position) {
          me.x = +m.position.x || 0;
          me.y = +m.position.y || 0;
          me.z = +m.position.z || 0;
        }
        me.ry = +m.ry || 0;
        me.hp = PLAYER_HP;
        broadcast({ type: "spawn", player: me });
        break;
      }

      case "pose": {
        const now = Date.now();
        const lastUpdate = lastPoseUpdate.get(id) || 0;

        // Throttle pose updates to prevent spam
        if (now - lastUpdate < POSE_UPDATE_INTERVAL) {
          return;
        }

        // Validate and update position
        if (Number.isFinite(m.x)) me.x = +m.x;
        if (Number.isFinite(m.y)) me.y = +m.y;
        if (Number.isFinite(m.z)) me.z = +m.z;
        if (Number.isFinite(m.ry)) me.ry = +m.ry;

        lastPoseUpdate.set(id, now);
        broadcastExcept(ws, { type: "pose", id, x: me.x, y: me.y, z: me.z, ry: me.ry });
        break;
      }

      case "fire": {
        broadcast({ type: "fire", id, origin: m.origin, dir: m.dir, t: Date.now() });
        break;
      }

      case "clientHit": {
        const victim = players.get(m.victimId);
        if (!victim || victim.hp <= 0 || victim.id === id) break;

        // Fixed: Added proper variable declaration
        const dmg = 20; // Fixed damage amount
        victim.hp = Math.max(0, victim.hp - dmg);
        broadcast({ type: "hit", victimId: victim.id, by: id, hp: victim.hp });

        if (victim.hp <= 0) {
          broadcast({ type: "death", id: victim.id, by: id });
          setTimeout(() => {
            const v = players.get(victim.id);
            if (!v) return;
            v.hp = PLAYER_HP;
            v.x = (Math.random() * 2 - 1) * 3;
            v.z = (Math.random() * 2 - 1) * 3;
            v.y = 0;
            broadcast({ type: "respawn", player: v });
          }, 1500);
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    players.delete(id);
    clients.delete(ws);
    lastPoseUpdate.delete(id);
    broadcast({ type: "leave", id });
  });
});

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

function broadcastExcept(exceptWs, msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws !== exceptWs && ws.readyState === ws.OPEN) ws.send(data);
}
