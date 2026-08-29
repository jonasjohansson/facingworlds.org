const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");

// 8081, not 8080: `npm start` serves the static site on 8080, so a dev client pointed at
// ws://localhost:8080 connects to the http-server (or whatever else holds the port) and
// reports ONLINE while no game traffic flows. Render supplies PORT in production.
const PORT = process.env.PORT || 8081;
const PLAYER_HP = 100;
const MAX_NAME = 24;
const POSE_UPDATE_INTERVAL = 50; // ms - throttle pose updates

// ---- validation / anti-cheat tuning ----
const HEARTBEAT_INTERVAL = 15000; // ms between pings; two misses reaps the socket
const MAX_POSE_SPEED = 100; // u/s ceiling incl. tower falls — anything faster is a teleport
const POSE_SLACK = 6; // units of tolerance on top of speed*dt (lag spikes)
const POSE_REJECT_LIMIT = 5; // after this many rejects in a row we resync to the client
const WORLD_LIMIT = 500; // absolute coordinate clamp (map spans ~±45)
const HIT_DAMAGE = 20; // fixed server-side damage per hit
const MAX_HIT_RANGE = 300; // no sightline on Face is anywhere near this long
const HIT_ORDER_GRACE = 150; // ms a hit may arrive AHEAD of the fire that paid for it
const SHOT_LIFETIME = 2500; // ms a fired shot stays eligible to produce a hit
const MAX_PENDING_SHOTS = 32;
const FIRE_MIN_INTERVAL = 80; // ms — fastest honest weapon is 8 shots/sec (125ms), leave headroom
const FIRE_BURST = 5; // token bucket depth, absorbs client timing jitter
const HIT_MIN_INTERVAL = 80; // ms — an honest hit cannot outpace the fire rate
const HIT_BURST = 4;
const SESSION_TTL = 120000; // ms a disconnected player's score is held for resume
const RESPAWN_DELAY = 1500;

const players = new Map(); // id -> {id,name,hp,x,y,z,ry,kills,...private fields}
const clients = new Map(); // ws -> id
const lastPoseUpdate = new Map(); // id -> timestamp
const sessions = new Map(); // sessionKey -> {kills,name,expires} — score resume across reconnects
const claimedSessions = new Map(); // sessionKey -> live player id currently owning that key
const spectators = new Map(); // ws -> spectator id (observers, never part of the game)

// Optional TLS. A phone on the LAN opens the site over https:// (self-signed mkcert),
// and a secure page may not open a plain ws:// socket to a LAN IP — browsers block it as
// mixed content, so the AR spectator table would silently watch nothing. Point SSL_CERT
// and SSL_KEY at the same pair the static server uses and this listens for wss:// on the
// same port instead. Unset (the default) is byte-for-byte the previous plain-ws server.
function createServer() {
  const certPath = process.env.SSL_CERT;
  const keyPath = process.env.SSL_KEY;
  if (!certPath || !keyPath) {
    return new WebSocketServer({ port: PORT }, () => console.log(`✅ ws server on :${PORT}`));
  }

  // A misread cert must fail loudly here rather than half-start an unreachable server.
  const creds = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  const httpsServer = https.createServer(creds);
  httpsServer.listen(PORT, () => console.log(`✅ wss server on :${PORT} (TLS)`));
  return new WebSocketServer({ server: httpsServer });
}

const wss = createServer();

const id4 = () => crypto.randomBytes(3).toString("hex");

// Quantize to 2 decimals (1cm) for position, 3 for radians — cuts JSON payloads roughly in half
const q2 = (n) => Math.round(n * 100) / 100;
const q3 = (n) => Math.round(n * 1000) / 1000;

// Strict numeric guard. JSON turns NaN/Infinity into null and `+null` is 0, so a
// plain Number.isFinite(+v) check would silently accept garbage as the origin.
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// Never leak private fields (session token, anti-cheat bookkeeping) to other clients
function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    hp: p.hp,
    x: q2(p.x),
    y: q2(p.y),
    z: q2(p.z),
    ry: q3(p.ry),
    kills: p.kills || 0,
    speed: q2(p.speed || 0),
    animation: p.animation || { idle: 1, walk: 0, run: 0 },
  };
}

// Token bucket shared by the fire and hit limiters
function takeToken(bucket, now, interval, depth) {
  const elapsed = now - bucket.ts;
  bucket.ts = now;
  bucket.tokens = Math.min(depth, bucket.tokens + elapsed / interval);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// A client that connects with ?spectate=1 is a pure observer (AR spectator table, stream
// overlay, …). req.url is attacker-controlled and may be absent on odd transports, so this
// must never throw — anything unparseable is treated as a normal player.
function isSpectatorRequest(req) {
  try {
    const raw = req && req.url;
    if (typeof raw !== "string" || raw.length === 0) return false;
    const v = new URL(raw, "http://localhost").searchParams.get("spectate");
    if (v === null) return false;
    return v !== "0" && v.toLowerCase() !== "false";
  } catch {
    return false;
  }
}

// Session tokens live in localStorage, which is shared by every tab of the same origin —
// exactly how this game gets tested locally. Two tabs therefore present the SAME token and,
// keyed naively, their stashes clobber each other on disconnect. Only the first live claimant
// gets the bare key; every later connection presenting an already-claimed token is given a
// private, per-connection key (and no resume, since the score under the bare key belongs to
// the connection still holding it).
function claimSession(id, token) {
  if (!claimedSessions.has(token)) {
    claimedSessions.set(token, id);
    return { key: token, resumable: true };
  }
  const key = `${token}#${id}`;
  claimedSessions.set(key, id);
  return { key, resumable: false };
}

function releaseSession(key, id) {
  if (key && claimedSessions.get(key) === id) claimedSessions.delete(key);
}

function randomSpawn(p) {
  p.x = (Math.random() * 2 - 1) * 5;
  p.y = 0;
  p.z = (Math.random() * 2 - 1) * 5;
  p.lastX = p.x;
  p.lastY = p.y;
  p.lastZ = p.z;
  p.poseRejects = 0;
  return p;
}

wss.on("connection", (ws, req) => {
  // Heartbeat — a socket that misses two pings is dead and gets reaped. Wired for
  // spectators too, before the early return below, so observer sockets cannot leak.
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  if (isSpectatorRequest(req)) {
    const sid = id4();
    ws.isSpectator = true;
    spectators.set(ws, sid);
    console.log(`[server] spectator ${sid} connected (${spectators.size} watching)`);

    // A spectator is never in `players`, so it is never broadcast as a join, never in
    // highscore-update, and never targetable. It still sees the whole world: broadcast()
    // walks wss.clients, which includes this socket.
    send(ws, {
      type: "hello",
      yourId: sid,
      spectator: true,
      players: [...players.values()].map(publicPlayer),
    });
    // Seed the scoreboard for this socket only — the players must learn nothing.
    send(ws, { type: "highscore-update", players: highscoreList() });

    // Every inbound message is dropped on the floor. A spectator cannot pose, fire, hit,
    // rename or spawn, so it has no way to mutate game state or grief.
    ws.on("message", () => {});

    ws.on("close", () => {
      spectators.delete(ws);
      // No leave broadcast — nobody was ever told this socket joined.
      console.log(`[server] spectator ${sid} disconnected (${spectators.size} watching)`);
    });

    ws.on("error", (err) => {
      console.warn(`[server] spectator socket error for ${sid}:`, err && err.message);
    });
    return;
  }

  const id = id4();
  clients.set(ws, id);

  const p = {
    id,
    name: `Player_${id}`,
    hp: PLAYER_HP,
    x: 0,
    y: 0,
    z: 0,
    ry: 0,
    kills: 0,
    speed: 0,
    // --- private (never sent to other clients) ---
    session: null,
    sessionResumable: false, // false when this connection was isolated off a claimed token
    lastX: 0,
    lastY: 0,
    lastZ: 0,
    poseRejects: 0,
    spawned: false, // the client sends "spawn" exactly once, right after connecting
    shots: [], // timestamps of fired-but-unclaimed shots
    pendingHit: null, // one hit awaiting the fire message right behind it
    fireBucket: { tokens: FIRE_BURST, ts: Date.now() },
    hitBucket: { tokens: HIT_BURST, ts: Date.now() },
    // last broadcast pose, for "did anything actually change" suppression
    bx: null,
    by: null,
    bz: null,
    bry: null,
    banim: "",
  };
  randomSpawn(p);
  players.set(id, p);

  send(ws, { type: "hello", yourId: id, players: [...players.values()].map(publicPlayer) });
  broadcastExcept(ws, { type: "join", player: publicPlayer(p) });
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
            .slice(0, MAX_NAME)
            .trim() || `Player_${id}`;
        me.name = clean;

        // Optional session token — lets a reconnecting player resume the score the
        // SERVER counted for them, instead of the client declaring its own score.
        if (!me.session && typeof m.session === "string" && m.session.length > 0) {
          const { key, resumable } = claimSession(id, m.session.slice(0, 64));
          me.session = key;
          me.sessionResumable = resumable;
          const stash = resumable ? sessions.get(key) : null;
          if (stash && stash.expires > Date.now()) {
            me.kills = stash.kills;
            sessions.delete(key);
            console.log(`[server] ${clean} resumed session with ${me.kills} kills`);
          } else if (!resumable) {
            console.log(`[server] ${clean} presented an already-claimed session token; isolated as ${key}`);
          }
        }

        broadcast({ type: "name", id, name: clean });
        broadcastHighscore();
        break;
      }

      case "setScore": {
        // Neutered on purpose: kills are counted server-side in `clientHit`, so a
        // client can no longer declare its own score. Accepted and ignored so that
        // older clients (which still send this on connect) do not break.
        break;
      }

      case "spawn": {
        // Honoured ONCE per connection. The client sends it immediately after the socket
        // opens, to tell us where it actually stands. Accepting it again would hand any
        // client a free full heal and an unchecked teleport to any coordinate, which
        // would defeat both the server-side damage model and the pose plausibility cap
        // below. Respawns are server-driven (see applyHit) and never come from here.
        if (me.spawned) break;
        me.spawned = true;
        if (m.position && isNum(m.position.x) && isNum(m.position.y) && isNum(m.position.z)) {
          me.x = clampWorld(m.position.x);
          me.y = clampWorld(m.position.y);
          me.z = clampWorld(m.position.z);
        }
        if (isNum(m.ry)) me.ry = m.ry;
        me.hp = PLAYER_HP;
        // Spawning is a legitimate teleport — reset the plausibility baseline
        me.lastX = me.x;
        me.lastY = me.y;
        me.lastZ = me.z;
        me.poseRejects = 0;
        me.shots.length = 0;
        me.pendingHit = null;
        // Don't reset kills — they are owned by the server
        broadcast({ type: "spawn", player: publicPlayer(me) });
        break;
      }

      case "pose": {
        const now = Date.now();
        const lastUpdate = lastPoseUpdate.get(id) || 0;

        // Throttle pose updates to prevent spam
        if (now - lastUpdate < POSE_UPDATE_INTERVAL) return;

        // Reject anything non-numeric outright rather than partially applying it
        const x = m.x,
          y = m.y,
          z = m.z,
          ry = m.ry;
        if (!isNum(x) || !isNum(y) || !isNum(z) || !isNum(ry)) return;
        if (Math.abs(x) > WORLD_LIMIT || Math.abs(y) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) return;

        // Teleport check — cap the distance covered since the last accepted pose
        const dt = Math.min(1, Math.max(0.02, (now - (lastUpdate || now)) / 1000));
        const maxDist = MAX_POSE_SPEED * dt + POSE_SLACK;
        const dx = x - me.lastX,
          dy = y - me.lastY,
          dz = z - me.lastZ;
        if (dx * dx + dy * dy + dz * dz > maxDist * maxDist) {
          me.poseRejects++;
          // A long stall can look like a teleport; after a few in a row believe the
          // client and resync rather than freezing them in place forever.
          if (me.poseRejects <= POSE_REJECT_LIMIT) {
            lastPoseUpdate.set(id, now);
            return;
          }
        }
        me.poseRejects = 0;

        me.x = x;
        me.y = y;
        me.z = z;
        me.ry = ry;
        me.lastX = x;
        me.lastY = y;
        me.lastZ = z;
        if (isNum(m.speed)) me.speed = Math.max(0, Math.min(MAX_POSE_SPEED, m.speed));

        // Store animation state
        if (m.animation) {
          me.animation = {
            idle: clamp01(m.animation.idle),
            walk: clamp01(m.animation.walk),
            run: clamp01(m.animation.run),
          };
        }

        lastPoseUpdate.set(id, now);

        // Quantize, then skip the broadcast entirely if nothing meaningfully moved
        const qx = q2(me.x),
          qy = q2(me.y),
          qz = q2(me.z),
          qry = q3(me.ry);
        const anim = me.animation || { idle: 1, walk: 0, run: 0 };
        const animKey = `${q2(anim.idle)},${q2(anim.walk)},${q2(anim.run)}`;
        if (qx === me.bx && qy === me.by && qz === me.bz && qry === me.bry && animKey === me.banim) return;

        const animChanged = animKey !== me.banim;
        me.bx = qx;
        me.by = qy;
        me.bz = qz;
        me.bry = qry;
        me.banim = animKey;

        const out = { type: "pose", id, t: now, x: qx, y: qy, z: qz, ry: qry, speed: q2(me.speed || 0) };
        // Only ship the animation block when it actually changed (clients carry it forward)
        if (animChanged) out.animation = anim;
        broadcastExcept(ws, out);
        break;
      }

      case "fire": {
        const now = Date.now();
        if (me.hp <= 0) break;
        if (!m.origin || !m.dir) break;
        const ox = m.origin.x,
          oy = m.origin.y,
          oz = m.origin.z;
        const dxr = m.dir.x,
          dyr = m.dir.y,
          dzr = m.dir.z;
        if (![ox, oy, oz, dxr, dyr, dzr].every(isNum)) break;
        if (Math.abs(ox) > WORLD_LIMIT || Math.abs(oy) > WORLD_LIMIT || Math.abs(oz) > WORLD_LIMIT) break;
        if (!takeToken(me.fireBucket, now, FIRE_MIN_INTERVAL, FIRE_BURST)) break;

        // Credit the shot — a hit must later be paid for by one of these
        me.shots.push(now);
        if (me.shots.length > MAX_PENDING_SHOTS) me.shots.shift();

        // A hitscan client resolves the trace before it tells us it fired, so the
        // clientHit can legitimately arrive just ahead of its own fire. Settle any
        // hit that was parked waiting for this shot.
        if (me.pendingHit) {
          const ph = me.pendingHit;
          me.pendingHit = null;
          if (now - ph.at <= HIT_ORDER_GRACE && canHit(me, ph.victimId)) {
            me.shots.shift();
            applyHit(me, players.get(ph.victimId));
          }
        }

        broadcastExcept(ws, {
          type: "fire",
          id,
          origin: { x: q2(ox), y: q2(oy), z: q2(oz) },
          dir: { x: q3(dxr), y: q3(dyr), z: q3(dzr) },
          t: now,
        });
        break;
      }

      case "clientHit": {
        const now = Date.now();
        if (!canHit(me, m.victimId)) break;

        // Rate limit: an honest client cannot land hits faster than it can fire
        if (!takeToken(me.hitBucket, now, HIT_MIN_INTERVAL, HIT_BURST)) break;

        // Every hit must be paid for by a shot this player actually fired recently
        while (me.shots.length && now - me.shots[0] > SHOT_LIFETIME) me.shots.shift();
        if (me.shots.length) {
          me.shots.shift();
          applyHit(me, players.get(m.victimId));
        } else {
          // No shot to pay for it yet. Park it — the matching "fire" may be a
          // fraction of a millisecond behind (see the fire handler). One only, so
          // this can never become a queue of free damage.
          me.pendingHit = { victimId: m.victimId, at: now };
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    const me = players.get(id);
    // Hold this player's server-counted score briefly so a reconnect can resume it.
    // An isolated key (`token#<playerId>`) contains a per-connection id that no future
    // connection can ever present, so stashing under it is a write nothing can read —
    // skip it rather than parking dead entries in `sessions` for the whole TTL.
    if (me && me.session) {
      if (me.sessionResumable) {
        sessions.set(me.session, { kills: me.kills || 0, name: me.name, expires: Date.now() + SESSION_TTL });
      }
      releaseSession(me.session, id);
    }
    players.delete(id);
    clients.delete(ws);
    lastPoseUpdate.delete(id);
    broadcast({ type: "leave", id });
    broadcastHighscore(); // Update highscore when player leaves
  });

  ws.on("error", (err) => {
    console.warn(`[server] socket error for ${id}:`, err && err.message);
  });
});

// ---- heartbeat: reap sockets that stopped answering, sweep expired sessions ----
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }

  const now = Date.now();
  for (const [key, s] of sessions) if (s.expires <= now) sessions.delete(key);
}, HEARTBEAT_INTERVAL);

wss.on("close", () => clearInterval(heartbeat));

function clamp01(n) {
  return isNum(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function clampWorld(n) {
  return Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, n));
}

// Preconditions shared by the immediate and the parked (out-of-order) hit paths.
// Dead players don't shoot, dead players don't get shot, nobody shoots themselves,
// and the victim has to be plausibly within weapon range of the shooter.
function canHit(shooter, victimId) {
  const victim = players.get(victimId);
  if (!victim || victim.hp <= 0 || victim.id === shooter.id || shooter.hp <= 0) return false;
  const dx = victim.x - shooter.x,
    dy = victim.y - shooter.y,
    dz = victim.z - shooter.z;
  return dx * dx + dy * dy + dz * dz <= MAX_HIT_RANGE * MAX_HIT_RANGE;
}

function applyHit(shooter, victim) {
  const dmg = HIT_DAMAGE; // the client never gets to pick
  victim.hp = Math.max(0, victim.hp - dmg);
  broadcast({ type: "hit", victimId: victim.id, victimName: victim.name, by: shooter.id, hp: victim.hp });
  if (victim.hp > 0) return;

  // Award kill to attacker
  shooter.kills++;
  console.log(`[server] ${shooter.name} killed ${victim.name} (${shooter.kills} kills)`);

  broadcast({ type: "death", id: victim.id, by: shooter.id });
  broadcast({ type: "player-kill", killerId: shooter.id, victimId: victim.id });
  broadcastHighscore(); // Broadcast updated highscore

  setTimeout(() => {
    const v = players.get(victim.id);
    if (!v) return;
    v.hp = PLAYER_HP;
    randomSpawn(v);
    v.animation = { idle: 1, walk: 0, run: 0 };
    v.speed = 0;
    v.shots.length = 0;
    v.pendingHit = null;
    broadcast({ type: "respawn", player: publicPlayer(v) });
  }, RESPAWN_DELAY);
}

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

// Built from `players` only, so a spectator can never appear on the scoreboard
function highscoreList() {
  return Array.from(players.values()).map((player) => ({
    id: player.id,
    name: player.name,
    kills: player.kills || 0,
  }));
}

function broadcastHighscore() {
  broadcast({
    type: "highscore-update",
    players: highscoreList(),
  });
}
