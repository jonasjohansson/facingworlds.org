const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const PLAYER_HP = 100;
const MAX_NAME = 24;
const POSE_UPDATE_INTERVAL = 50; // ms - throttle pose updates

const players = new Map(); // id -> {id,name,hp,x,y,z,ry,kills}
const clients = new Map(); // ws -> id
const lastPoseUpdate = new Map(); // id -> timestamp

const wss = new WebSocketServer({ port: PORT }, () => console.log(`✅ ws server on :${PORT}`));

const id4 = () => crypto.randomBytes(3).toString("hex");

wss.on("connection", (ws) => {
  const id = id4();
  clients.set(ws, id);

  // Random spawn position for new players
  const spawnX = (Math.random() * 2 - 1) * 5;
  const spawnZ = (Math.random() * 2 - 1) * 5;
  const p = { id, name: `Player_${id}`, hp: PLAYER_HP, x: spawnX, y: 0, z: spawnZ, ry: 0, kills: 0 };
  players.set(id, p);

  send(ws, { type: "hello", yourId: id, players: [...players.values()] });
  broadcastExcept(ws, { type: "join", player: p });
  broadcastHighscore(); // Send initial highscore

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

      case "setScore": {
        // Cap score to prevent spoofing — only accept if within 1 of current (reconnect tolerance)
        const score = Math.max(0, Math.min(9999, parseInt(m.score) || 0));
        // Only allow setting score higher by at most 1 (normal kill increment)
        if (score <= me.kills + 1) {
          me.kills = score;
        }
        broadcastHighscore();
        break;
      }

      case "spawn": {
        console.log(`[server] Spawn request from ${id}:`, m);
        if (m.position) {
          me.x = +m.position.x || 0;
          me.y = +m.position.y || 0;
          me.z = +m.position.z || 0;
          console.log(`[server] Set spawn position: (${me.x}, ${me.y}, ${me.z})`);
        }
        me.ry = +m.ry || 0;
        me.hp = PLAYER_HP;
        me.kills = 0; // Reset kills on spawn
        console.log(`[server] Broadcasting spawn for ${id}:`, me);
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

        // Store velocity data for animation
        if (Number.isFinite(m.vx)) me.vx = +m.vx;
        if (Number.isFinite(m.vy)) me.vy = +m.vy;
        if (Number.isFinite(m.vz)) me.vz = +m.vz;
        if (Number.isFinite(m.speed)) me.speed = +m.speed;

        // Store animation state
        if (m.animation) {
          me.animation = m.animation;
        }

        lastPoseUpdate.set(id, now);
        broadcastExcept(ws, {
          type: "pose",
          id,
          x: me.x,
          y: me.y,
          z: me.z,
          ry: me.ry,
          vx: me.vx || 0,
          vy: me.vy || 0,
          vz: me.vz || 0,
          speed: me.speed || 0,
          animation: me.animation || { idle: 1, walk: 0, run: 0 },
        });
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
        broadcast({ type: "hit", victimId: victim.id, victimName: victim.name, by: id, hp: victim.hp });

        if (victim.hp <= 0) {
          // Award kill to attacker
          const killer = players.get(id);
          if (killer) {
            killer.kills++;
            console.log(`[server] ${killer.name} killed ${victim.name} (${killer.kills} kills)`);
          }

          broadcast({ type: "death", id: victim.id, by: id });
          broadcast({ type: "player-kill", killerId: id, victimId: victim.id });
          broadcastHighscore(); // Broadcast updated highscore

          setTimeout(() => {
            const v = players.get(victim.id);
            if (!v) return;
            v.hp = PLAYER_HP;
            v.x = (Math.random() * 2 - 1) * 5;
            v.z = (Math.random() * 2 - 1) * 5;
            v.y = 0;
            v.animation = { idle: 1, walk: 0, run: 0 };
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
    broadcastHighscore(); // Update highscore when player leaves
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

function broadcastHighscore() {
  const playersList = Array.from(players.values()).map((player) => ({
    id: player.id,
    name: player.name,
    kills: player.kills || 0,
  }));

  broadcast({
    type: "highscore-update",
    players: playersList,
  });
}
