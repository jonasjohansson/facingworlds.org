// Capture the Flag — end-to-end test against a REAL server process.
//
// Nothing here is stubbed: the suite spawns `node server/server.js` on a free port with the
// CTF knobs turned down (2 captures to win, a 1.5s auto-return, a 1.2s reset dwell) and
// drives it with genuine `ws` clients. Every assertion is made on the wire, because the
// whole point of the CTF rules living server-side is that a client cannot talk its way
// past them — a test that called the functions directly would prove nothing about that.
//
// The one piece of ceremony that is NOT optional: poses. The server caps plausible motion
// at MAX_POSE_SPEED (100 u/s) + POSE_SLACK (6) over a dt that clamps to one second, so a
// client may cover at most ~106 units per hop and only after pausing a full second since
// its last accepted pose. Every teleport below therefore waits ~1.06s and is confirmed by
// watching the spectator for the resulting `pose` broadcast — a silently rejected pose
// would otherwise leave the player at the spawn and make a perfectly good flag rule look
// broken. (An earlier hand-run pickup test failed on exactly that.)
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
// The SAME generated table the server reads, not a hand-copied set of literals. This file
// used to restate FLAG_HOMES, SPAWNS and the pickup positions as numbers, and every time
// the map moved there were three copies to remember. src/shared/map-actors.js is the ESM
// half of what scripts/gen-map-actors.mjs writes; server/map-actors.js is the CommonJS
// half the server requires; one run writes both. Importing it here means this suite
// cannot pass against a server standing somewhere else on the map.
import { FLAG_HOMES, SPAWNS, TOWER_ROOFS, BODY_ARMOR, MED_BOXES } from "../../src/shared/map-actors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(HERE, "..", "server.js");
const REPO_ROOT = path.join(HERE, "..", "..");

// 8751 by default (8099, 8731 and 8741 have all been used by earlier runs of this suite),
// but this repo gets worked on by several processes at once and a stale listener on the
// port would fail the whole suite for a reason that has nothing to do with CTF. Step to
// the next free port instead, and say so.
const BASE_PORT = Number(process.env.CTF_TEST_PORT) || 8751;
let PORT = BASE_PORT;
const CAP_LIMIT = 2;
const AUTO_RETURN_MS = 1500;
const MATCH_RESET_MS = 1200;

// ---- mirrored from server/server.js ----
// Not env-overridable there, so they cannot be injected the way the CTF timers above
// are. Written once here and derived from, rather than spelled out at each assertion:
// the previous version had "5" and "20" typed into a helper, a comment and three
// assertions, so changing the Enforcer's damage broke the suite in five places and
// none of them said why. If server.js moves, move these two and the suite follows.
const HIT_DAMAGE = 17; // UT99 Botpack.Enforcer HitDamage
const PLAYER_HP = 100;
const HITS_TO_KILL = Math.ceil(PLAYER_HP / HIT_DAMAGE); // 6
const HEALTH_PICKUP_HP = 20; // a UT99 MedBox
// PICKUP_RADIUS + PICKUP_CLAIM_SLACK: the 3D reach the server judges a claim against.
// Small now — it is a body touching an item, not a world distance — so a test that
// wants two pickups has to walk between them rather than stand between them.
const PICKUP_REACH = 1.6 + 1.0;

// CTF-Face's own FlagBase0 / FlagBase1, at the FOOT of each tower — the roofs are sniper
// decks and never held the flags. `ry`/`ut` are stripped because several assertions below
// are deepEqual against a flag's broadcast {x, y, z}, and the server strips them too.
const HOMES = {
  blue: { x: FLAG_HOMES.blue.x, y: FLAG_HOMES.blue.y, z: FLAG_HOMES.blue.z },
  red: { x: FLAG_HOMES.red.x, y: FLAG_HOMES.red.y, z: FLAG_HOMES.red.z },
};

// Unchanged by the world scale: MAX_POSE_SPEED (100 u/s) and POSE_SLACK (6) are a speed
// and a lag allowance, and neither moved when the map grew — so the per-hop budget is
// still ~106 units. What DID change is how many hops a trip takes, and `teleport` below
// already derives that from the distance.
const POSE_GAP_MS = 1060; // > 1s so dt clamps to 1 and the hop budget is the full ~106u
const MAX_HOP = 90; // stay comfortably inside 106u

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const q2 = (n) => Math.round(n * 100) / 100;
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------- server process

let child = null;
const serverLog = [];

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "0.0.0.0");
  });
}

async function pickPort() {
  for (let port = BASE_PORT; port < BASE_PORT + 20; port++) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(`no free port in ${BASE_PORT}..${BASE_PORT + 19}`);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    env.PORT = String(PORT);
    env.CTF_CAP_LIMIT = String(CAP_LIMIT);
    env.CTF_AUTO_RETURN_MS = String(AUTO_RETURN_MS);
    env.CTF_MATCH_RESET_MS = String(MATCH_RESET_MS);
    // Plain ws, never TLS: an inherited SSL_CERT/SSL_KEY would silently turn this into a
    // wss server and every client below would fail to connect for the wrong reason.
    delete env.SSL_CERT;
    delete env.SSL_KEY;
    // No bots. This suite is about the rules a HUMAN client is held to, and every
    // assertion below reads the whole world off one spectator socket: a bot roster would
    // put extra players in `hello`, take the teams off 2/2, and walk a flag off its stand
    // in the middle of a test that is waiting to see nothing happen. The bots go through
    // the very same tryTouchFlag/applyHit functions these tests exercise (server/bots.js
    // calls them directly), so turning them off here loses no coverage of the rules.
    env.BOTS_ENABLED = "0";

    child = spawn(process.execPath, [SERVER_JS], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let ready = false;
    const timer = setTimeout(() => {
      reject(new Error(`server never reported ready on :${PORT}\n${serverLog.join("")}`));
    }, 10000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      serverLog.push(d);
      if (!ready && /server on :/.test(d)) {
        ready = true;
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => serverLog.push(d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(`server exited early (code ${code}, signal ${signal})\n${serverLog.join("")}`));
      }
    });
  });
}

// ---------------------------------------------------------------- test clients

const allClients = [];

// `session` sends the optional resume token on setName, exactly as the browser client does
// (network.js `send({type:"setName", name, session: getSessionToken()})`). `autoSpawn:false`
// holds the `spawn` message back so a test can watch the resume flip the team FIRST and
// only then ask for the spawn point the new side is owed.
function connect(name, { spectate = false, session = null, autoSpawn = true } = {}) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${PORT}/${spectate ? "?spectate=1" : ""}`;
    const ws = new WebSocket(url);
    const c = {
      name,
      ws,
      id: null,
      team: null,
      spectator: spectate,
      hello: null,
      log: [], // every message this client received, in order
      waiters: [],
      pos: { x: 0, y: 0, z: 0 },
      lastPoseAt: 0,
      nudge: 0,
      send(msg) {
        ws.send(JSON.stringify(msg));
      },
      mark() {
        return this.log.length;
      },
      close() {
        return new Promise((r) => {
          if (ws.readyState === WebSocket.CLOSED) return r();
          ws.once("close", r);
          ws.close();
        });
      },
    };
    allClients.push(c);

    const timer = setTimeout(() => reject(new Error(`${name}: no hello within 5s`)), 5000);

    ws.on("message", (buf) => {
      let m;
      try {
        m = JSON.parse(buf.toString());
      } catch {
        return;
      }
      c.log.push(m);

      if (m.type === "hello") {
        c.hello = m;
        c.id = m.yourId;
        c.team = m.team;
        if (!spectate) {
          // Name first: `byName` on every flag broadcast is the server's copy of it, and
          // an unnamed client would only ever prove that Player_<id> took the flag.
          c.send(session ? { type: "setName", name, session } : { type: "setName", name });
          // The server ignores any position we assert here; it already picked one and
          // shipped it in hello.spawn. Adopt it, then open the pose stream from that
          // exact point so the plausibility baseline and our idea of "where I am" agree.
          c.pos = { x: m.spawn.x, y: m.spawn.y, z: m.spawn.z };
          if (autoSpawn) {
            c.send({ type: "spawn" });
            c.send({ type: "pose", x: c.pos.x, y: c.pos.y, z: c.pos.z, ry: 0, speed: 0 });
            c.lastPoseAt = Date.now();
          }
        }
        clearTimeout(timer);
        resolve(c);
      }
      // A respawn is a server-side teleport; if we kept posing from the old spot every
      // pose would be a rejected "teleport" until the reject limit gave up and believed us.
      // Same for the `spawn` echo: with autoSpawn off the server re-rolls the point when
      // the team changed underneath us, and hello.spawn is then a stale idea of "here".
      if ((m.type === "respawn" || m.type === "spawn") && m.player && m.player.id === c.id) {
        c.pos = { x: m.player.x, y: m.player.y, z: m.player.z };
      }

      for (const w of [...c.waiters]) {
        const hit = w.scan();
        if (!hit) continue;
        clearTimeout(w.timer);
        c.waiters.splice(c.waiters.indexOf(w), 1);
        w.resolve(hit);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitFor(c, pred, { timeout = 2500, from = 0, what = "message" } = {}) {
  return new Promise((resolve, reject) => {
    const scan = () => {
      for (let i = from; i < c.log.length; i++) if (pred(c.log[i])) return c.log[i];
      return null;
    };
    const hit = scan();
    if (hit) return resolve(hit);
    const w = { scan, resolve };
    w.timer = setTimeout(() => {
      c.waiters.splice(c.waiters.indexOf(w), 1);
      const seen = c.log
        .slice(from)
        .map((m) => m.type)
        .join(", ");
      reject(new Error(`${c.name}: timed out after ${timeout}ms waiting for ${what}; saw: [${seen}]`));
    }, timeout);
    c.waiters.push(w);
  });
}

async function expectNone(c, pred, { ms = 600, from = 0, what = "message" } = {}) {
  await sleep(ms);
  const hit = c.log.slice(from).find(pred);
  assert.equal(hit && JSON.stringify(hit), undefined, `${c.name}: expected NO ${what}, got ${JSON.stringify(hit)}`);
}

// ---------------------------------------------------------------- movement

let witness = null; // the spectator; every pose/flag broadcast lands here

async function poseTo(c, x, y, z) {
  const wait = POSE_GAP_MS - (Date.now() - c.lastPoseAt);
  if (wait > 0) await sleep(wait);
  const from = witness.mark();
  c.send({ type: "pose", x, y, z, ry: 0, speed: 0 });
  c.lastPoseAt = Date.now();
  c.pos = { x, y, z };
  // The server only rebroadcasts a pose it accepted, so this doubles as proof that the
  // hop cleared the plausibility cap.
  await waitFor(
    witness,
    (m) => m.type === "pose" && m.id === c.id && near(m.x, x, 0.005) && near(m.y, y, 0.005) && near(m.z, z, 0.005),
    { timeout: 2000, from, what: `accepted pose for ${c.name} at (${x}, ${y}, ${z})` }
  );
}

// Walk `c` to `target` in hops the plausibility cap will accept. Each destination carries
// a tiny per-client nudge so two consecutive stops are never bit-identical: the server
// suppresses a pose broadcast that quantises to the previous one, which would leave the
// confirmation above waiting for a message that is never sent.
async function teleport(c, target) {
  c.nudge = c.nudge >= 0.15 ? 0.01 : q2(c.nudge + 0.01);
  const tx = q2(target.x + c.nudge);
  const ty = target.y;
  const tz = target.z;
  const start = { ...c.pos };
  const hops = Math.max(1, Math.ceil(dist(start, { x: tx, y: ty, z: tz }) / MAX_HOP));
  for (let i = 1; i <= hops; i++) {
    const t = i / hops;
    await poseTo(c, q2(start.x + (tx - start.x) * t), q2(start.y + (ty - start.y) * t), q2(start.z + (tz - start.z) * t));
  }
}

// Enough hits of the server's fixed HIT_DAMAGE to take a full-health player down. Fire
// first, hit right behind it: the server makes every hit pay for itself with a recent
// shot from the same player.
async function killPlayer(shooter, victim) {
  const from = witness.mark();
  for (let i = 0; i < HITS_TO_KILL; i++) {
    shooter.send({ type: "fire", origin: { ...shooter.pos }, dir: { x: 1, y: 0, z: 0 } });
    await sleep(30);
    shooter.send({ type: "clientHit", victimId: victim.id });
    await sleep(95);
  }
  await waitFor(witness, (m) => m.type === "death" && m.id === victim.id, {
    timeout: 4000,
    from,
    what: `death of ${victim.name}`,
  });
  return from;
}

async function waitRespawn(c) {
  const from = c.mark();
  await waitFor(c, (m) => m.type === "respawn" && m.player && m.player.id === c.id, {
    timeout: 4000,
    from: Math.max(0, from - 40),
    what: `respawn of ${c.name}`,
  });
}

const isFlag = (team, event) => (m) => m.type === "flag" && m.team === team && m.event === event;

// ---------------------------------------------------------------- suite state

let A, B, C, D, spec;
let blue1, blue2, red1, red2;

before(async () => {
  PORT = await pickPort();
  if (PORT !== BASE_PORT) console.log(`# port ${BASE_PORT} was busy — running the server on ${PORT}`);
  await startServer();
});

after(async () => {
  for (const c of allClients) {
    try {
      await c.close();
    } catch {
      /* already gone */
    }
  }
  if (child && child.exitCode === null) child.kill("SIGKILL");
});

// ---------------------------------------------------------------- tests

test("four sequential joins are auto-balanced 2/2 and every hello carries the CTF world", async () => {
  A = await connect("A");
  B = await connect("B");
  C = await connect("C");
  D = await connect("D");
  for (const c of [A, B, C, D]) {
    assert.ok(c.team === "red" || c.team === "blue", `${c.name}: hello.team was ${JSON.stringify(c.team)}`);
  }
  const reds = [A, B, C, D].filter((c) => c.team === "red");
  const blues = [A, B, C, D].filter((c) => c.team === "blue");
  assert.equal(reds.length, 2, `expected 2 red, got ${reds.map((c) => c.name).join(",")}`);
  assert.equal(blues.length, 2, `expected 2 blue, got ${blues.map((c) => c.name).join(",")}`);
  // Alternating, not clustered: back-to-back joiners must land on opposite sides.
  assert.notEqual(A.team, B.team, "A and B landed on the same team");
  assert.notEqual(C.team, D.team, "C and D landed on the same team");
  [red1, red2] = reds;
  [blue1, blue2] = blues;

  // The last hello sees the full roster, each row team-stamped and carrying no flag.
  assert.equal(D.hello.players.length, 4);
  for (const p of D.hello.players) {
    assert.ok(p.team === "red" || p.team === "blue", `player ${p.id} had team ${JSON.stringify(p.team)}`);
    assert.equal(p.flag, null);
  }

  const ctf = D.hello.ctf;
  assert.ok(ctf, "hello.ctf missing");
  assert.equal(ctf.capLimit, CAP_LIMIT, "CTF_CAP_LIMIT env knob was not honoured");
  assert.equal(ctf.state, "playing");
  assert.equal(ctf.winner, null);
  assert.deepEqual(ctf.scores, { red: 0, blue: 0 });
  assert.equal(ctf.flags.length, 2);
  for (const f of ctf.flags) {
    const home = HOMES[f.team];
    assert.ok(home, `unknown flag team ${f.team}`);
    assert.equal(f.state, "home");
    assert.equal(f.carrier, null);
    assert.equal(f.returnInMs, 0);
    assert.deepEqual({ x: f.x, y: f.y, z: f.z }, home, `${f.team} flag is not on its home stand`);
  }
});

test("a spectator gets team null, the CTF world, and the broadcast stream", async () => {
  spec = await connect("SPEC", { spectate: true });
  witness = spec;
  assert.equal(spec.hello.spectator, true);
  assert.equal(spec.hello.team, null);
  assert.ok(spec.hello.ctf, "spectator hello.ctf missing");
  assert.equal(spec.hello.ctf.capLimit, CAP_LIMIT);
  assert.equal(spec.hello.players.length, 4);
});

test("touching a flag from across the map does nothing", async () => {
  const from = spec.mark();
  red2.send({ type: "touchFlag", team: "blue" }); // enemy flag, but ~200 units away
  await expectNone(spec, (m) => m.type === "flag", { from, what: "flag message for an out-of-range touch" });
});

test("own-team touch of a flag standing at home does nothing", async () => {
  await teleport(blue2, HOMES.blue);
  const from = spec.mark();
  blue2.send({ type: "touchFlag", team: "blue" });
  await expectNone(spec, (m) => m.type === "flag", { from, what: "flag message for an own home-flag touch" });
});

test("enemy touch takes the flag and every client is told, with the documented fields", async () => {
  await teleport(blue1, HOMES.red);
  const from = { A: A.mark(), B: B.mark(), C: C.mark(), D: D.mark(), S: spec.mark() };
  blue1.send({ type: "touchFlag", team: "red" });

  const msg = await waitFor(spec, isFlag("red", "taken"), { from: from.S, what: "flag taken" });
  assert.equal(msg.state, "carried");
  assert.equal(msg.carrier, blue1.id);
  assert.equal(msg.by, blue1.id);
  assert.equal(msg.byName, blue1.name);
  assert.equal(msg.byTeam, "blue");
  assert.equal(msg.returnInMs, 0);
  assert.ok(near(msg.x, HOMES.red.x), `flag x ${msg.x} is not where the carrier stood`);
  assert.ok(near(msg.y, HOMES.red.y), `flag y ${msg.y} is not the red plinth`);
  assert.ok(near(msg.z, HOMES.red.z), `flag z ${msg.z} is not where the carrier stood`);

  // Not just the spectator: all four players see the same transition.
  for (const [c, idx] of [
    [A, from.A],
    [B, from.B],
    [C, from.C],
    [D, from.D],
  ]) {
    const seen = await waitFor(c, isFlag("red", "taken"), { from: idx, what: "flag taken" });
    assert.equal(seen.carrier, blue1.id);
  }

  // publicPlayer now advertises the carry — check it the way a late joiner would.
  const late = await connect("SPEC2", { spectate: true });
  const row = late.hello.players.find((p) => p.id === blue1.id);
  assert.ok(row, "carrier missing from a late hello");
  assert.equal(row.flag, "red", "publicPlayer.flag does not report the carried flag");
  assert.equal(row.team, "blue");
  const lateFlag = late.hello.ctf.flags.find((f) => f.team === "red");
  assert.equal(lateFlag.state, "carried");
  assert.equal(lateFlag.carrier, blue1.id);
  await late.close();
});

test("a flag already being carried cannot be taken again", async () => {
  await sleep(250); // stay inside the touch rate limiter
  const from = spec.mark();
  blue1.send({ type: "touchFlag", team: "red" });
  await expectNone(spec, (m) => m.type === "flag", { from, what: "flag message for a re-take of a carried flag" });
});

test("killing the carrier drops the flag at the carrier's position, before the death", async () => {
  await teleport(red1, HOMES.red);
  const carrierPos = { ...blue1.pos };
  const from = await killPlayer(red1, blue1);

  const dropped = await waitFor(spec, isFlag("red", "dropped"), { from, what: "flag dropped" });
  assert.equal(dropped.state, "dropped");
  assert.equal(dropped.carrier, null);
  assert.equal(dropped.by, blue1.id);
  assert.equal(dropped.byTeam, "blue");
  assert.ok(near(dropped.x, carrierPos.x, 0.05), `dropped at x ${dropped.x}, carrier was at ${carrierPos.x}`);
  assert.ok(near(dropped.y, carrierPos.y, 0.05), `dropped at y ${dropped.y}, carrier was at ${carrierPos.y}`);
  assert.ok(near(dropped.z, carrierPos.z, 0.05), `dropped at z ${dropped.z}, carrier was at ${carrierPos.z}`);
  assert.ok(
    dropped.returnInMs > 0 && dropped.returnInMs <= AUTO_RETURN_MS,
    `returnInMs ${dropped.returnInMs} is not a live ${AUTO_RETURN_MS}ms timer`
  );

  const dropIdx = spec.log.indexOf(dropped);
  const deathIdx = spec.log.findIndex((m, i) => i >= from && m.type === "death" && m.id === blue1.id);
  assert.ok(dropIdx < deathIdx, `flag drop (idx ${dropIdx}) must arrive before death (idx ${deathIdx})`);
});

test("own-team touch of a dropped flag returns it home", async () => {
  const from = spec.mark();
  red1.send({ type: "touchFlag", team: "red" });
  const returned = await waitFor(spec, isFlag("red", "returned"), { from, what: "flag returned" });
  assert.equal(returned.state, "home");
  assert.equal(returned.carrier, null);
  assert.equal(returned.by, red1.id);
  assert.equal(returned.byName, red1.name);
  assert.equal(returned.byTeam, "red");
  assert.equal(returned.returnInMs, 0);
  assert.deepEqual({ x: returned.x, y: returned.y, z: returned.z }, HOMES.red);
});

test("a dropped flag nobody reaches auto-returns on the server's timer", async () => {
  await waitRespawn(blue1);
  await teleport(blue1, HOMES.red);
  let from = spec.mark();
  blue1.send({ type: "touchFlag", team: "red" });
  await waitFor(spec, isFlag("red", "taken"), { from, what: "flag taken (second time)" });

  from = await killPlayer(red1, blue1);
  const dropped = await waitFor(spec, isFlag("red", "dropped"), { from, what: "flag dropped (second time)" });
  const droppedAt = Date.now();

  const returned = await waitFor(spec, isFlag("red", "returned"), {
    from: spec.log.indexOf(dropped) + 1,
    timeout: AUTO_RETURN_MS + 2000,
    what: "automatic flag return",
  });
  assert.equal(returned.by, null, "an auto-return must credit nobody");
  assert.equal(returned.byName, null);
  assert.equal(returned.byTeam, null);
  assert.equal(returned.state, "home");
  assert.deepEqual({ x: returned.x, y: returned.y, z: returned.z }, HOMES.red);
  const elapsed = Date.now() - droppedAt;
  assert.ok(elapsed >= AUTO_RETURN_MS - 100, `auto-return fired after only ${elapsed}ms`);
});

test("no capture while your own flag is away, and returning it is not a capture", async () => {
  await waitRespawn(blue1);
  await teleport(red2, HOMES.blue);
  let from = spec.mark();
  red2.send({ type: "touchFlag", team: "blue" });
  const taken = await waitFor(spec, isFlag("blue", "taken"), { from, what: "blue flag taken" });
  assert.equal(taken.carrier, red2.id);
  assert.equal(taken.byTeam, "red");

  await teleport(blue1, HOMES.red);
  from = spec.mark();
  blue1.send({ type: "touchFlag", team: "red" });
  await waitFor(spec, isFlag("red", "taken"), { from, what: "red flag taken (third time)" });

  // Carrying the enemy flag, standing on my own stand — but my flag is in enemy hands.
  await teleport(blue1, HOMES.blue);
  from = spec.mark();
  blue1.send({ type: "touchFlag", team: "blue" });
  await expectNone(spec, (m) => m.type === "ctf-score" || (m.type === "flag" && m.event === "captured"), {
    from,
    what: "capture while my own flag is away",
  });

  // Shoot the thief; the flag falls at his feet, right next to my own stand.
  from = await killPlayer(blue2, red2);
  const dropped = await waitFor(spec, isFlag("blue", "dropped"), { from, what: "blue flag dropped" });
  assert.equal(dropped.by, red2.id);

  // Touching my own DROPPED flag returns it. It does not also score.
  await sleep(250);
  from = spec.mark();
  blue1.send({ type: "touchFlag", team: "blue" });
  const returned = await waitFor(spec, isFlag("blue", "returned"), { from, what: "blue flag returned by a player" });
  assert.equal(returned.by, blue1.id);
  assert.equal(returned.state, "home");
  await expectNone(spec, (m) => m.type === "ctf-score", { ms: 300, from, what: "score for a mere return" });
});

test("capture scores once the flag is home again, and broadcasts the documented fields", async () => {
  await sleep(250);
  const from = spec.mark();
  blue1.send({ type: "touchFlag", team: "blue" });

  const captured = await waitFor(spec, isFlag("red", "captured"), { from, what: "flag captured" });
  assert.equal(captured.state, "home", "a captured flag goes back to its own stand");
  assert.equal(captured.carrier, null);
  assert.equal(captured.by, blue1.id);
  assert.equal(captured.byName, blue1.name);
  assert.equal(captured.byTeam, "blue");
  assert.deepEqual({ x: captured.x, y: captured.y, z: captured.z }, HOMES.red);

  const score = await waitFor(spec, (m) => m.type === "ctf-score", { from, what: "ctf-score" });
  assert.deepEqual(score.scores, { red: 0, blue: 1 });
  assert.equal(score.by, blue1.id);
  assert.equal(score.team, "blue");
  assert.ok(spec.log.indexOf(captured) < spec.log.indexOf(score), "flag captured must precede ctf-score");

  // The carry is spent: touching my own stand again is not a second point.
  await sleep(250);
  const after = spec.mark();
  blue1.send({ type: "touchFlag", team: "blue" });
  await expectNone(spec, (m) => m.type === "ctf-score", { from: after, what: "a second score from one capture" });
});

test("reaching the cap limit ends the match, freezes CTF, then resets the world", async () => {
  await waitRespawn(red2);
  await Promise.all([teleport(blue1, HOMES.red), teleport(red2, HOMES.blue)]);

  let from = spec.mark();
  blue1.send({ type: "touchFlag", team: "red" });
  await waitFor(spec, isFlag("red", "taken"), { from, what: "red flag taken (winning run)" });

  await teleport(blue1, HOMES.blue);
  from = spec.mark();
  blue1.send({ type: "touchFlag", team: "blue" });
  const score = await waitFor(spec, (m) => m.type === "ctf-score", { from, what: "second ctf-score" });
  assert.deepEqual(score.scores, { red: 0, blue: CAP_LIMIT });

  const end = await waitFor(spec, (m) => m.type === "match-end", { from, what: "match-end" });
  assert.equal(end.winner, "blue");
  assert.deepEqual(end.scores, { red: 0, blue: CAP_LIMIT });
  assert.equal(end.resetInMs, MATCH_RESET_MS);
  assert.ok(spec.log.indexOf(score) < spec.log.indexOf(end), "ctf-score must precede match-end");

  // red2 is standing on the (home) blue flag as an enemy — a take that would certainly
  // work mid-match. A decided match must refuse it.
  const frozen = spec.mark();
  red2.send({ type: "touchFlag", team: "blue" });
  await expectNone(spec, (m) => m.type === "flag" && m.event === "taken", {
    ms: 500,
    from: frozen,
    what: "a flag take after the match ended",
  });

  const reset = await waitFor(spec, (m) => m.type === "match-reset", {
    from: spec.log.indexOf(end) + 1,
    timeout: MATCH_RESET_MS + 3000,
    what: "match-reset",
  });
  assert.deepEqual(reset.ctf.scores, { red: 0, blue: 0 });
  assert.equal(reset.ctf.state, "playing");
  assert.equal(reset.ctf.winner, null);
  for (const f of reset.ctf.flags) {
    assert.equal(f.state, "home", `${f.team} flag did not go home on reset`);
    assert.equal(f.carrier, null);
    assert.deepEqual({ x: f.x, y: f.y, z: f.z }, HOMES[f.team]);
  }
  // Both flags are announced individually too, so a client has one code path to write.
  for (const team of ["red", "blue"]) {
    const msg = await waitFor(spec, isFlag(team, "reset"), {
      from: spec.log.indexOf(end) + 1,
      timeout: 1000,
      what: `${team} flag reset event`,
    });
    assert.equal(msg.by, null);
    assert.equal(msg.state, "home");
  }

  const hs = await waitFor(spec, (m) => m.type === "highscore-update", {
    from: spec.log.indexOf(reset) + 1,
    what: "highscore-update after the reset",
  });
  assert.equal(hs.players.length, 4);
  for (const row of hs.players) {
    assert.equal(row.kills, 0, `${row.name} kept ${row.kills} kills through the reset`);
    assert.ok(row.team === "red" || row.team === "blue", "highscore rows must carry team");
  }
});

test("disconnecting with the flag drops it rather than taking it out of the match", async () => {
  await teleport(blue1, HOMES.red);
  let from = spec.mark();
  blue1.send({ type: "touchFlag", team: "red" });
  await waitFor(spec, isFlag("red", "taken"), { from, what: "red flag taken (post-reset)" });

  from = spec.mark();
  await blue1.close();
  const dropped = await waitFor(spec, isFlag("red", "dropped"), { from, what: "flag dropped on disconnect" });
  assert.equal(dropped.by, blue1.id);
  assert.equal(dropped.state, "dropped");
  assert.equal(dropped.carrier, null);
  assert.ok(dropped.returnInMs > 0, "the auto-return timer must start on a disconnect drop too");
  assert.ok(near(dropped.x, HOMES.red.x), `dropped at x ${dropped.x}`);
  assert.ok(near(dropped.y, HOMES.red.y), `dropped at y ${dropped.y}`);
});

// ================================================================ part two
// Everything below drives the same live server; the world state it inherits is whatever
// the tests above left behind, so each one starts by settling the world (flags home,
// nobody mid-respawn) rather than assuming.

// All twenty of CTF-Face's PlayerStarts, ten a side, handed out round-robin with up to
// SPAWN_JITTER of jitter on x and z. The two clusters are ~190 units apart along x, so
// "which team's spawn is this?" is never a close call. SPAWN_JITTER is sized against the
// player capsule, not the map, so it is the one number here that is still a literal.
const SPAWN_POINTS = SPAWNS;
const SPAWN_JITTER = 1.0;
// The two Enforcer pedestals — on the tower ROOFS, where the original puts its Body Armor
// (definePickup in server.js). Picked the same way the server picks them, by which roof
// each one is nearest to, so a swapped pair in the table would fail here rather than
// silently testing the wrong pedestal.
const nearestArmor = (team) => {
  const c = TOWER_ROOFS[team];
  const d2 = (a) => (a.x - c.x) ** 2 + (a.z - c.z) ** 2;
  return BODY_ARMOR.reduce((best, a) => (d2(a) < d2(best) ? a : best));
};
// The two Body Armor points on the sniper decks. They used to carry a second Enforcer,
// a stand-in from when CTF-Face's own item set was not placed; they now carry the armour
// UT99 puts there, so these tests exercise armour instead of dual-wielding. The ids are
// the generated ones: `<class>-<actor name>`.
const PEDESTALS = {
  red: { id: `armor2-${nearestArmor("red").name}`, ...nearestArmor("red") },
  blue: { id: `armor2-${nearestArmor("blue").name}`, ...nearestArmor("blue") },
};
const other = (t) => (t === "red" ? "blue" : "red");

function assertAtTeamSpawn(player, team, what) {
  const ok = SPAWN_POINTS[team].some(
    (s) =>
      Math.abs(player.x - s.x) <= SPAWN_JITTER + 0.05 &&
      Math.abs(player.z - s.z) <= SPAWN_JITTER + 0.05 &&
      near(player.y, s.y, 0.02)
  );
  assert.ok(ok, `${what}: (${player.x}, ${player.y}, ${player.z}) is not one of the ${team} spawns`);
}

// A throwaway spectator's `hello` is the cleanest read of server truth there is: the full
// roster (team, hp, kills, dual, flag) plus the CTF world, all built by the same
// publicPlayer/publicCtf the real clients get. Cheaper and far less racy than trying to
// reconstruct the state from the broadcast stream.
let probeSeq = 0;
async function worldSnapshot() {
  const probe = await connect(`SNAP${++probeSeq}`, { spectate: true });
  const { hello } = probe;
  await probe.close();
  return hello;
}

// Wait until the world is quiet: both flags home and nobody lying dead waiting on a
// respawn timer. The previous test may have left a flag mid auto-return.
async function settle({ timeout = AUTO_RETURN_MS + 6000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const hello = await worldSnapshot();
    const homeOk = hello.ctf.flags.every((f) => f.state === "home");
    const aliveOk = hello.players.every((p) => p.hp > 0);
    if (homeOk && aliveOk) return hello;
    if (Date.now() > deadline) {
      throw new Error(
        `world never settled: flags ${JSON.stringify(hello.ctf.flags.map((f) => [f.team, f.state]))}, ` +
          `hp ${JSON.stringify(hello.players.map((p) => [p.name, p.hp]))}`
      );
    }
    await sleep(250);
  }
}

function rosterCounts(hello) {
  const counts = { red: 0, blue: 0 };
  for (const p of hello.players) if (p.team === "red" || p.team === "blue") counts[p.team]++;
  return counts;
}

// Land `shots` hits (HIT_DAMAGE each) without killing anyone. Same fire-then-hit pacing
// as killPlayer: the server makes every hit pay for a shot the same player actually fired.
async function hurt(shooter, victim, shots) {
  const from = spec.mark();
  for (let i = 0; i < shots; i++) {
    shooter.send({ type: "fire", origin: { ...shooter.pos }, dir: { x: 1, y: 0, z: 0 } });
    await sleep(30);
    shooter.send({ type: "clientHit", victimId: victim.id });
    await sleep(95);
  }
  const hits = spec.log.slice(from).filter((m) => m.type === "hit" && m.victimId === victim.id);
  assert.equal(hits.length, shots, `${shooter.name} landed ${hits.length} of ${shots} hits on ${victim.name}`);
  return hits[hits.length - 1].hp;
}

// Poll the server's own stdout. Used only where the wire cannot tell two outcomes apart —
// "resumed a stash of 0 kills" and "never resumed anything" both look like kills: 0.
async function serverSaid(re, { timeout = 3000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (re.test(serverLog.join(""))) return true;
    if (Date.now() > deadline) throw new Error(`server never logged ${re}\n${serverLog.join("")}`);
    await sleep(100);
  }
}

// Ask for the spawn the server owes us and read back the point it picked.
async function spawnManually(c) {
  const from = c.mark();
  c.send({ type: "spawn" });
  const msg = await waitFor(c, (m) => m.type === "spawn" && m.player && m.player.id === c.id, {
    from,
    what: `spawn broadcast for ${c.name}`,
  });
  c.lastPoseAt = Date.now();
  return msg.player;
}

// A whole capture run: take the enemy flag off its stand, carry it home, touch your own.
async function captureRun(c) {
  const enemy = other(c.team);
  await teleport(c, HOMES[enemy]);
  let from = spec.mark();
  c.send({ type: "touchFlag", team: enemy });
  await waitFor(spec, isFlag(enemy, "taken"), { from, what: `${c.name} taking the ${enemy} flag` });
  await teleport(c, HOMES[c.team]);
  from = spec.mark();
  c.send({ type: "touchFlag", team: c.team });
  return await waitFor(spec, (m) => m.type === "ctf-score", { from, what: `${c.name}'s capture` });
}

let resumeToken = null; // the session token the resume tests hand back and forth
let racer = null; // whichever of the two racers below won the flag
let loser = null; // and the one that did not
const fillers = []; // extra bodies connected only to even the sides out

test("two clients touching the same flag in one tick take it exactly once", async () => {
  await settle();
  // Both red, both standing on the blue stand, both asking in the same tick. The server
  // handles the two messages back to back, and the second must find the flag already
  // carried — otherwise both walk away with it and the match has two blue flags in it.
  await Promise.all([teleport(red1, HOMES.blue), teleport(red2, HOMES.blue)]);

  const from = spec.mark();
  red1.send({ type: "touchFlag", team: "blue" });
  red2.send({ type: "touchFlag", team: "blue" });

  const first = await waitFor(spec, isFlag("blue", "taken"), { from, what: "the blue flag being taken" });
  await sleep(400); // long enough for a second take to have shown up
  const takes = spec.log.slice(from).filter(isFlag("blue", "taken"));
  assert.equal(takes.length, 1, `two racers produced ${takes.length} takes: ${JSON.stringify(takes)}`);
  assert.ok(
    first.carrier === red1.id || first.carrier === red2.id,
    `carrier ${first.carrier} is neither racer (${red1.id}, ${red2.id})`
  );

  racer = first.carrier === red1.id ? red1 : red2;
  loser = racer === red1 ? red2 : red1;

  // The loser must not be holding a phantom copy: one carrier, one flag.
  const hello = await worldSnapshot();
  const winnerRow = hello.players.find((p) => p.id === racer.id);
  const loserRow = hello.players.find((p) => p.id === loser.id);
  assert.equal(winnerRow.flag, "blue", "the winner of the race is not carrying the flag");
  assert.equal(loserRow.flag, null, `${loser.name} also walked away with the flag`);
  const blueFlag = hello.ctf.flags.find((f) => f.team === "blue");
  assert.equal(blueFlag.state, "carried");
  assert.equal(blueFlag.carrier, racer.id);
});

test("a carrier killed under the map sends the flag home rather than dropping it into the void", async () => {
  // Face is two towers over a bottomless drop, so dying while falling is ordinary here.
  // A flag dropped at y = -116.78 (the old -50, x world scale) is a flag nobody could ever
  // touch again: the world mesh itself bottoms out at -33.1 and MAP_FLOOR_Y is -4.67.
  await teleport(racer, { x: HOMES.blue.x, y: -116.78, z: HOMES.blue.z });
  assert.ok(near(racer.pos.y, -116.78, 0.01), `the carrier is at y ${racer.pos.y}, not under the map`);

  const from = await killPlayer(blue2, racer);
  const returned = await waitFor(spec, isFlag("blue", "returned"), { from, what: "the void-drop return" });
  assert.equal(returned.state, "home");
  assert.equal(returned.carrier, null);
  assert.equal(returned.by, null, "a void drop credits nobody");
  assert.equal(returned.byName, null);
  assert.equal(returned.byTeam, null);
  assert.equal(returned.returnInMs, 0, "a returned flag has no auto-return timer running");
  assert.deepEqual({ x: returned.x, y: returned.y, z: returned.z }, HOMES.blue);

  // It went home instead of dropping — there must be no "dropped" event at all.
  const dropped = spec.log.slice(from).find(isFlag("blue", "dropped"));
  assert.equal(dropped && JSON.stringify(dropped), undefined, "the flag was dropped into the void");

  // The flag falls before the body, here as everywhere else.
  const deathIdx = spec.log.findIndex((m, i) => i >= from && m.type === "death" && m.id === racer.id);
  assert.ok(spec.log.indexOf(returned) < deathIdx, "the return must be broadcast before the death");

  await waitRespawn(racer);
});

test("a dead player's touchFlag is ignored", async () => {
  await settle();
  // Standing exactly where a live touch would work — the loser of the race never moved off
  // the blue stand — so being dead is the only thing left to refuse them for.
  await teleport(loser, HOMES.blue);
  const from = await killPlayer(blue2, loser);
  loser.send({ type: "touchFlag", team: "blue" });
  await expectNone(spec, (m) => m.type === "flag", {
    ms: 700, // well inside the 1500ms respawn delay
    from,
    what: "flag message for a corpse's touch",
  });

  const hello = await worldSnapshot();
  const blueFlag = hello.ctf.flags.find((f) => f.team === "blue");
  assert.equal(blueFlag.state, "home", "a corpse moved the flag");
  await waitRespawn(loser);
});

test("the flag touch rate limiter refuses a burst, then lets the take through", async () => {
  await settle();
  await teleport(loser, HOMES.blue);

  // Drain the bucket (3 tokens, one back every 150ms) with touches of our OWN flag, ~200
  // units away: no-ops that still cost a token, because the limiter runs before the team
  // and distance checks. The take that follows is refused for the rate limit alone.
  const from = spec.mark();
  for (let i = 0; i < 8; i++) loser.send({ type: "touchFlag", team: "red" });
  loser.send({ type: "touchFlag", team: "blue" });
  await expectNone(spec, (m) => m.type === "flag", { ms: 400, from, what: "a take made through a drained bucket" });

  // Same player, same spot, same request — only the tokens have grown back. If this take
  // fails the refusal above proved nothing about the limiter.
  await sleep(300);
  const from2 = spec.mark();
  loser.send({ type: "touchFlag", team: "blue" });
  const taken = await waitFor(spec, isFlag("blue", "taken"), { from: from2, what: "the take once tokens regrew" });
  assert.equal(taken.carrier, loser.id);

  // Clean up: shoot the carrier on the roof and let the auto-return put the flag back.
  const from3 = await killPlayer(blue2, loser);
  await waitFor(spec, isFlag("blue", "dropped"), { from: from3, what: "the cleanup drop" });
  const home = await waitFor(spec, isFlag("blue", "returned"), {
    from: from3,
    timeout: AUTO_RETURN_MS + 2000,
    what: "the cleanup auto-return",
  });
  assert.equal(home.by, null);
  await waitRespawn(loser);
});

test("a pose above the roofs is rejected away from a tower and accepted over one", async () => {
  await settle();
  // Mid-map, on the bridge, at a height the server has no complaint about. (The old
  // (4, 3, 0) x world scale.)
  await teleport(blue2, { x: 9.34, y: 7.01, z: 0 });

  // y = 93.42 out here is nowhere near either roof (both are 86+ units away in x, against a
  // ROOF_HALF_EXTENT.x of 19.03), so it is a fly hack rather than a lag spike: above
  // ROOF_AIRSPACE_Y (72.55) the only legal airspace is directly over a tower. The hop
  // itself is ~86 units, still inside the ~106-unit speed cap, so the plausibility check
  // has no reason to touch it.
  await sleep(POSE_GAP_MS - (Date.now() - blue2.lastPoseAt));
  const from = spec.mark();
  blue2.send({ type: "pose", x: 10.51, y: 93.42, z: 1.17, ry: 0, speed: 0 });
  blue2.lastPoseAt = Date.now();
  await expectNone(spec, (m) => m.type === "pose" && m.id === blue2.id, {
    ms: 600,
    from,
    what: "a pose broadcast for a fly hack over the gap",
  });

  const stillDown = await worldSnapshot();
  const row = stillDown.players.find((p) => p.id === blue2.id);
  assert.ok(near(row.y, 7.01, 0.02), `the rejected pose moved the player to y ${row.y}`);

  // The same height directly over the blue roof is legal — a player really can stand up
  // there, and the rule must not ground them. TOWER_ROOFS, not HOMES: the flags came down
  // to ground level, so the flag home is no longer a point above a tower and using it here
  // would only pass by accident. `teleport` rather than a single `poseTo` because the
  // bridge and the blue roof are ~121 units apart, more than one hop's ~106-unit budget;
  // the intermediate stop sits at y ~50, below ROOF_AIRSPACE_Y, so it is legal wherever it
  // lands.
  await teleport(blue2, { x: TOWER_ROOFS.blue.x, y: 93.42, z: TOWER_ROOFS.blue.z });
  const up = await worldSnapshot();
  assert.ok(near(up.players.find((p) => p.id === blue2.id).y, 93.42, 0.02), "a pose over a roof was rejected");

  // Stand back down ON the roof deck before leaving. A trip from here to the other tower
  // takes two hops, and the midpoint of a hop that starts 22 units ABOVE the roofs is
  // itself above ROOF_AIRSPACE_Y but nowhere near either tower — i.e. the very fly hack
  // this test just proved the server refuses. Leaving the player parked up in the legal
  // column would make the next test's teleport fail for a correct reason.
  await poseTo(blue2, TOWER_ROOFS.blue.x, TOWER_ROOFS.blue.y, TOWER_ROOFS.blue.z);
});

test("a resumed session restores the team, spawns on that side, and keeps the server's kills", async () => {
  await settle();

  // The team flip on resume is deliberately conservative: it only happens while it keeps
  // the sides within one player of each other, which means it can only ever be observed
  // from an EVEN roster (an uneven one assigns by count and the flip would unbalance it).
  // So: even the sides out, then read the server's tiebreak by connecting a probe — the
  // side it lands on IS nextTieTeam, and the join flips it for the next tie.
  let even = false;
  for (let i = 0; i < 8 && !even; i++) {
    const counts = rosterCounts(await worldSnapshot());
    even = counts.red === counts.blue;
    // An uneven roster assigns the next join to the smaller side, so each filler closes
    // the gap by one.
    if (!even) fillers.push(await connect(`FILL${fillers.length + 1}`));
  }
  assert.ok(even, "could not even out the teams");
  const probe = await connect("PROBE");
  const tie = probe.team; // the side a tie went to
  const token = `ctf-test-session-${Date.now()}`;
  const resumer = await connect("RESUMER", { session: token });
  assert.equal(
    resumer.team,
    other(tie),
    "the probe made its side bigger, so the next join must go to the other one"
  );

  // A kill the SERVER counted. This is the number the resume has to hand back — a client
  // has no way to declare it (setScore is neutered).
  await killPlayer(resumer, probe);
  const before = await worldSnapshot();
  assert.equal(before.players.find((p) => p.id === resumer.id).kills, 1);

  // Drop both: the probe's side loses a player and the resumer's side loses one, so the
  // roster is even again and the reconnect below lands on the tiebreak side — the WRONG
  // side, which is exactly the case the stash has to correct.
  const leaving = spec.mark();
  await resumer.close();
  await probe.close();
  await waitFor(spec, (m) => m.type === "leave" && m.id === resumer.id, { from: leaving, what: "the resumer leaving" });
  await waitFor(spec, (m) => m.type === "leave" && m.id === probe.id, { from: leaving, what: "the probe leaving" });
  await sleep(200);

  const from = spec.mark();
  const back = await connect("RESUMER2", { session: token, autoSpawn: false });
  assert.equal(back.hello.team, tie, "the reconnect should have been handed the tiebreak side — the wrong one");

  // The stash rides in on setName, one message after hello, so the server tells everyone
  // rather than leaving the client to guess.
  const teamMsg = await waitFor(spec, (m) => m.type === "team" && m.id === back.id, {
    from,
    what: "the team message for a resumed session",
  });
  assert.equal(teamMsg.team, other(tie), "the resumed player was not put back on their old side");

  // Only now ask for the spawn: it must belong to the side the stash restored, not the one
  // hello handed out, and it must carry the score the server was holding.
  const player = await spawnManually(back);
  assert.equal(player.team, other(tie));
  assert.equal(player.hp, 100);
  assert.equal(player.flag, null);
  assertAtTeamSpawn(player, other(tie), "the resumed spawn");
  assert.ok(
    dist(player, back.hello.spawn) > 50,
    `the resumed spawn (${player.x}, ${player.z}) is the one hello handed out, not the ${other(tie)} side's`
  );
  assert.equal(player.kills, 1, "the server-counted kill did not survive the reconnect");
  await serverSaid(/RESUMER2 resumed session with 1 kills/);

  // The scoreboard is rebroadcast twice here: once on the join, where this player is a
  // stranger with nothing, and again out of setName once the stash has been applied. It is
  // the second one that has to carry the resumed score.
  const hs = await waitFor(
    spec,
    (m) => m.type === "highscore-update" && m.players.some((r) => r.id === back.id && r.kills === 1),
    { from, what: "a highscore row carrying the resumed kill" }
  );
  const row = hs.players.find((r) => r.id === back.id);
  assert.equal(row.team, other(tie));
  assert.equal(row.name, "RESUMER2");

  // Leave again, holding a stash of one kill. The next two tests are about what a match
  // reset does to it.
  const from2 = spec.mark();
  await back.close();
  await waitFor(spec, (m) => m.type === "leave" && m.id === back.id, { from: from2, what: "the resumer leaving again" });
  resumeToken = token;
});

test("a match reset puts everyone back on their feet with full hp and no armour", async () => {
  await settle();

  // Someone has to have something to lose: the Body Armor, and some damage.
  await teleport(red2, PEDESTALS.red);
  let from = spec.mark();
  red2.send({ type: "takePickup", id: PEDESTALS.red.id });
  const armorMsg = await waitFor(spec, (m) => m.type === "armor" && m.id === red2.id, {
    from,
    what: "the Body Armor pickup",
  });
  assert.ok(armorMsg.armor > 0, `armour did not stick, got ${armorMsg.armor}`);
  const hurtTo = await hurt(red1, red2, 2);
  assert.ok(hurtTo < 100, `expected ${red2.name} to be damaged, hp is ${hurtTo}`);

  const armed = await worldSnapshot();
  const armedRow = armed.players.find((p) => p.id === red2.id);
  assert.ok(armedRow.armor > 0, "the pickup did not stick");
  assert.equal(armedRow.hp, hurtTo);

  // Two captures is the cap, so the second one ends the match and the reset follows.
  const first = await captureRun(blue2);
  assert.equal(first.scores.blue, 1);
  const second = await captureRun(blue2);
  assert.equal(second.scores.blue, CAP_LIMIT);

  const end = await waitFor(spec, (m) => m.type === "match-end", {
    from: spec.log.indexOf(second),
    what: "match-end",
  });
  const fromEnd = spec.log.indexOf(end) + 1;
  const reset = await waitFor(spec, (m) => m.type === "match-reset", {
    from: fromEnd,
    timeout: MATCH_RESET_MS + 3000,
    what: "match-reset",
  });
  // Every respawn is broadcast in the reset loop, before the match-reset message itself.
  const respawns = spec.log.slice(fromEnd, spec.log.indexOf(reset)).filter((m) => m.type === "respawn");
  const loadouts = spec.log.slice(fromEnd, spec.log.indexOf(reset)).filter((m) => m.type === "loadout");

  const after = await worldSnapshot();
  assert.ok(after.players.length >= 4, `only ${after.players.length} players left to check`);
  for (const p of after.players) {
    const r = respawns.find((m) => m.player.id === p.id);
    assert.ok(r, `${p.name} was not respawned by the reset`);
    assert.equal(r.player.hp, 100, `${p.name} came back with ${r.player.hp} hp`);
    assert.equal(r.player.armor || 0, 0, `${p.name} carried armour across the reset`);
    assert.equal(r.player.flag, null);
    assert.equal(r.player.kills, 0);
    assertAtTeamSpawn(r.player, r.player.team, `${p.name}'s reset spawn`);
    // And the snapshot agrees with the broadcast, so this is server state and not a
    // one-off message that lied.
    assert.equal(p.hp, 100, `${p.name} is at ${p.hp} hp after the reset`);
    assert.equal(p.dual, false, `${p.name} still has dual after the reset`);
    assert.ok(
      loadouts.some((m) => m.id === p.id && m.dual === false),
      `${p.name} was never told the second Enforcer is gone`
    );
  }
  // The damaged, dual-wielding player is the whole point of the test.
  const healed = respawns.find((m) => m.player.id === red2.id);
  assert.equal(healed.player.hp, 100, "the damaged player was not healed by the reset");
  assert.equal(healed.player.dual, false, "the second Enforcer survived the reset");
});

test("the match reset wipes the score stashed for a disconnected player too", async () => {
  // The stash left behind two tests ago held one kill. A reset zeroes the live players'
  // frags; a player who reconnects into the new match must not resume a dead score either.
  assert.ok(resumeToken, "the resume test did not leave a session token behind");
  const back = await connect("RESUMER3", { session: resumeToken });
  // "resumed with 0 kills" and "never resumed at all" look identical on the wire, so this
  // is the one place the server's own log is the evidence.
  await serverSaid(/RESUMER3 resumed session with 0 kills/);

  const hello = await worldSnapshot();
  const row = hello.players.find((p) => p.id === back.id);
  assert.ok(row, "the reconnected player is missing from the roster");
  assert.equal(row.kills, 0, "a stashed score outlived the match reset");
  assert.equal(row.hp, 100);
});

// The world sweep in server.js runs every 500ms and owns both of the backstops below:
// the orphaned-carrier drop and the auto-return of a dropped flag.
const SWEEP_MS = 500;

test("a carrier whose socket is terminated without a close handshake does not keep the flag", async () => {
  await settle();

  // A body of its own, so killing the connection cannot cost the tests above a player.
  const ghost = await connect("GHOST");
  const enemy = other(ghost.team);
  await teleport(ghost, HOMES[enemy]);
  let from = spec.mark();
  ghost.send({ type: "touchFlag", team: enemy });
  const taken = await waitFor(spec, isFlag(enemy, "taken"), { from, what: `GHOST taking the ${enemy} flag` });
  assert.equal(taken.carrier, ghost.id);

  // terminate(), not close(): the socket is destroyed without a closing handshake, which
  // is what a crashed tab, a killed process or a yanked cable actually looks like.
  //
  // Two things can rescue the flag from that, and the test deliberately does not care
  // which one gets there first: the `close` handler (which drops it explicitly) and, if
  // that never runs — a socket error, a heartbeat reap, an exception between the two —
  // the world sweep's orphaned-carrier branch. What must NOT happen is the flag sitting
  // in "carried" behind a player nobody can shoot, which takes the rest of the match
  // with it. One sweep period is the outer bound on how long that may take.
  from = spec.mark();
  const killedAt = Date.now();
  ghost.ws.terminate();

  const back = await waitFor(
    spec,
    (m) => m.type === "flag" && m.team === enemy && (m.event === "dropped" || m.event === "returned"),
    { from, timeout: SWEEP_MS + 3000, what: `the ${enemy} flag leaving a dead carrier` }
  );
  const elapsed = Date.now() - killedAt;
  assert.ok(elapsed <= SWEEP_MS + 1000, `the flag stayed on a dead carrier for ${elapsed}ms`);
  assert.equal(back.carrier, null, "the flag still names the terminated player as its carrier");
  if (back.event === "dropped") {
    assert.ok(back.returnInMs > 0, "a drop must start the auto-return timer, or the flag is stranded");
    assert.ok(inPlayableReach(back), `the flag was dropped at (${back.x}, ${back.y}, ${back.z})`);
  } else {
    assert.deepEqual({ x: back.x, y: back.y, z: back.z }, HOMES[enemy]);
  }

  // And the server agrees, rather than having only said so once on the wire.
  const hello = await worldSnapshot();
  const f = hello.ctf.flags.find((x) => x.team === enemy);
  assert.notEqual(f.state, "carried", "the flag is still carried after the socket died");
  assert.equal(f.carrier, null);
  assert.ok(
    !hello.players.some((p) => p.id === ghost.id),
    "the terminated socket left its player on the roster"
  );

  // Leave the world as we found it: whatever state it is in, the sweep takes it home.
  await settle();
});

// A dropped flag has to be somewhere a player could stand — the drop is only useful if
// someone can reach it. Both roof decks are at y 71.06, the flag plinths and the ground
// are around 0, and the map's derived bounds are x -151.4..176.6 / z -100.9..84.0. Every
// bound here is looser than all of that on purpose: it is a "did the flag end up
// somewhere absurd" net, not a restatement of MAP_BOUNDS.
function inPlayableReach(f) {
  return Math.abs(f.x) <= 186.84 && Math.abs(f.z) <= 140.13 && f.y > -46.71 && f.y <= 74.74;
}

test("a capture attempt after the carried flag went home by another path scores nothing", async () => {
  await settle();

  const carrier = blue2; // blue, and alive: every other blue body has left by now
  const shooter = red1;
  const enemy = other(carrier.team);
  const before = (await worldSnapshot()).ctf.scores;

  await teleport(carrier, HOMES[enemy]);
  let from = spec.mark();
  carrier.send({ type: "touchFlag", team: enemy });
  await waitFor(spec, isFlag(enemy, "taken"), { from, what: `${carrier.name} taking the ${enemy} flag` });

  // Carry it all the way home — one touch short of the capture.
  await teleport(carrier, HOMES[carrier.team]);

  // Now take the flag off them by a path that is not a capture: shot on their own stand,
  // then the auto-return timer picks the flag up off the floor and sends it home. From
  // the client's point of view nothing said "you no longer have the flag" except a
  // broadcast it is free to have missed — a stale client goes on believing it is carrying.
  // Marked before the shot: the respawn below lands while we are still waiting out the
  // auto-return, so scanning back a fixed handful of messages for it would be a race.
  const beforeDeath = carrier.mark();
  from = await killPlayer(shooter, carrier);
  const dropped = await waitFor(spec, isFlag(enemy, "dropped"), { from, what: "the drop off the dead carrier" });
  const returned = await waitFor(spec, isFlag(enemy, "returned"), {
    from: spec.log.indexOf(dropped) + 1,
    timeout: AUTO_RETURN_MS + 2000,
    what: "the auto-return that takes the flag off the carrier for good",
  });
  assert.equal(returned.by, null, "this has to be the timer's return, not a player's");
  assert.equal(returned.state, "home");

  await waitFor(carrier, (m) => m.type === "respawn" && m.player && m.player.id === carrier.id, {
    from: beforeDeath,
    timeout: 4000,
    what: `respawn of ${carrier.name}`,
  });
  const mid = await worldSnapshot();
  assert.equal(
    mid.players.find((p) => p.id === carrier.id).flag,
    null,
    "the server still thinks the ex-carrier holds a flag"
  );

  // The stale client walks onto its own stand and claims the capture it thinks it earned.
  // The server's answer is silence: the capture branch refuses anyone whose half of the
  // fact ("I am carrying X") is not backed by the flag's half ("X's carrier is you").
  await teleport(carrier, HOMES[carrier.team]);
  from = spec.mark();
  carrier.send({ type: "touchFlag", team: carrier.team });
  await expectNone(spec, (m) => m.type === "ctf-score" || (m.type === "flag" && m.event === "captured"), {
    ms: 700,
    from,
    what: "a score for a capture claimed with no flag",
  });
  // Nor may it quietly move the flag it is standing on, or mint anything else.
  await expectNone(spec, (m) => m.type === "flag", { ms: 0, from, what: "any flag transition at all" });

  const after = await worldSnapshot();
  assert.deepEqual(after.ctf.scores, before, "the phantom capture moved the score");
  for (const f of after.ctf.flags) {
    assert.equal(f.state, "home", `the ${f.team} flag did not stay home through the phantom capture`);
    assert.equal(f.carrier, null);
  }

  // NOTE the other half of that guard — me.flag set while flags[me.flag].carrier names
  // someone else — has no reachable message ordering to test it with: every path that
  // takes a flag off a carrier (death, void drop, disconnect, match reset) clears both
  // halves together, and the one place they can diverge (the sweep's orphaned-carrier
  // branch) has already removed the player from `players`, so they can never ask again.
  // It stays in the server as explicit defence, not as a fix for a reachable race.
});

// ================================================================ health pickups
//
// The MedBoxes are the one pickup type that changes a number the rest of the game reads
// (hp), so the rules that keep it honest are worth pinning: it heals by a fixed amount, it
// does not overheal, and a player who is already full walks past it rather than banking
// its respawn. Run last, because taking a pickup puts it on a 20-second respawn and this
// leaves two of the eight down.
// The closest pair that is still further apart than `minGap`. CTF-Face stands its
// MedBoxes in rows, and the tightest blue pair is 1.85 apart — inside PICKUP_REACH, so
// one spot really does reach both (that is the map, and it is how a run down the alcove
// is supposed to collect the row). The test below needs the opposite: two boxes that
// cannot both be had from one place, so that the second claim proves the patient moved.
const nearestPairBeyond = (list, minGap) => {
  let best = null;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const d = Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z);
      if (d <= minGap) continue;
      if (!best || d < best.d) best = { d, a: list[i], b: list[j] };
    }
  }
  return best;
};

test("a MedBox heals by a fixed amount, does not overheal, and is refused at full health", async () => {
  await settle();

  // Two blue MedBoxes far enough apart that one standing spot cannot reach both. The
  // patient STANDS ON each in turn: PICKUP_REACH is 2.6 now, a body's arm rather than a
  // room, and it is the second claim FROM THE SECOND BOX that pins that down. The old
  // version of this test stood at the midpoint of the tightest pair and claimed both
  // from there, which only worked because the reach was 9.51.
  const pair = nearestPairBeyond(
    MED_BOXES.filter((b) => b.x < 0),
    PICKUP_REACH
  );
  assert.ok(pair, `no two blue MedBoxes are more than PICKUP_REACH (${PICKUP_REACH}) apart`);
  const { d, a: box1, b: box2 } = pair;
  // The server judges a claim in 3D; the pair above was chosen in plan. Same thing for
  // two boxes on one alcove floor, but assert it rather than assume it.
  assert.ok(
    dist(box1, box2) > PICKUP_REACH,
    `the chosen MedBoxes are ${q2(dist(box1, box2))} apart in 3D (${q2(d)} in plan), inside PICKUP_REACH (${PICKUP_REACH})`
  );
  await teleport(blue2, box1);

  const patient = blue2;
  const id1 = `medbox-${box1.name}`;
  const id2 = `medbox-${box2.name}`;

  // Full health: the item stays standing. This runs FIRST, while every box is still
  // available, so a refusal here cannot be the respawn timer wearing a disguise.
  const before = await worldSnapshot();
  assert.equal(before.players.find((p) => p.id === patient.id).hp, 100, "the patient did not start full");
  let from = spec.mark();
  patient.send({ type: "takePickup", id: id1 });
  await expectNone(spec, (m) => m.type === "pickup-taken" && m.id === id1, {
    from,
    what: "a MedBox taken by a player who is already at full health",
  });
  const untouched = (await worldSnapshot()).pickups.find((p) => p.id === id1);
  assert.equal(untouched.available, true, "the refused MedBox was put on a respawn anyway");

  // Now take some damage and try again. The test wants a hole that ONE MedBox cannot
  // fill and TWO overflow — that is what makes the first heal a measurable amount and
  // the second one a clamp. The fewest hits that dig a hole deeper than one MedBox is
  // the smallest N with N*HIT_DAMAGE > HEALTH_PICKUP_HP, and both halves are asserted
  // rather than assumed so a change to either constant fails here with the reason
  // instead of failing later with a number.
  const shots = Math.ceil((HEALTH_PICKUP_HP + 1) / HIT_DAMAGE);
  const expectHurt = PLAYER_HP - shots * HIT_DAMAGE;
  assert.ok(
    expectHurt > 0 && expectHurt + HEALTH_PICKUP_HP < PLAYER_HP && expectHurt + 2 * HEALTH_PICKUP_HP >= PLAYER_HP,
    `no hit count both survives and leaves a hole one ${HEALTH_PICKUP_HP} MedBox underfills and two overfill, ` +
      `at ${HIT_DAMAGE} damage a hit (tried ${shots} hits -> ${expectHurt} hp)`
  );
  const hurtTo = await hurt(red1, patient, shots);
  assert.equal(
    hurtTo,
    expectHurt,
    `${shots} hits of the server's fixed ${HIT_DAMAGE} should leave ${expectHurt}, got ${hurtTo}`
  );

  from = spec.mark();
  patient.send({ type: "takePickup", id: id1 });
  const healed = await waitFor(spec, (m) => m.type === "health" && m.id === patient.id, {
    from,
    what: "the health broadcast for the first MedBox",
  });
  assert.equal(healed.hp, expectHurt + HEALTH_PICKUP_HP, `a MedBox is worth ${HEALTH_PICKUP_HP}`);
  await waitFor(spec, (m) => m.type === "pickup-taken" && m.id === id1, { from, what: "the first MedBox being taken" });

  // The second one caps at 100 rather than overhealing past it — and the patient has to
  // WALK to it, because the first one is no longer within reach of the second.
  await teleport(patient, box2);
  from = spec.mark();
  patient.send({ type: "takePickup", id: id2 });
  const capped = await waitFor(spec, (m) => m.type === "health" && m.id === patient.id, {
    from,
    what: "the health broadcast for the second MedBox",
  });
  assert.equal(
    capped.hp,
    PLAYER_HP,
    `${expectHurt + HEALTH_PICKUP_HP} + ${HEALTH_PICKUP_HP} must clamp at ${PLAYER_HP}, not overheal`
  );

  // And the server's own copy agrees — the broadcast is not the only place hp moved.
  const after = await worldSnapshot();
  assert.equal(after.players.find((p) => p.id === patient.id).hp, PLAYER_HP);
});
