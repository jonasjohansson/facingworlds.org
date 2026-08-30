// Server-side bots — end-to-end, against a REAL server process, over REAL sockets.
//
// The premise of server/bots.js is that a bot is not a second kind of entity: it is an
// ordinary row in server.js's `players` map with no `ws`, so join/leave/pose/hit/death/
// respawn and the CTF rules all work on it unchanged. That claim is only worth anything
// if it holds ON THE WIRE, which is why nothing here is stubbed and nothing calls into
// bots.js: the suite spawns `node server/server.js`, watches one spectator socket, and
// plays as a human against whatever the roster produces.
//
// The companion suite, server/test/ctf.test.mjs, runs the same server with BOTS_ENABLED=0
// and proves the human rules on an empty map. This one is the other half of that bargain:
// bots must not break human play, so the two are meant to be run together —
// `node --test server/test/` — and neither shells out to the other: nesting one node:test
// runner inside another is refused by the runner itself ("run() is being called
// recursively within a test file"), and it would run the CTF suite twice in CI besides.
//
// WHAT IS DELIBERATELY *NOT* TURNED DOWN. BOTS_TICK_MS and BOTS_POSE_MS stay at their
// shipped 50 ms, because test 1 asserts that a bot's pose stream is indistinguishable
// from a human's — turning the cadence down to make the suite finish sooner would be
// asserting the knob rather than the behaviour. Everything else (the roster sweep, the
// re-plan cadence, the flag return timer) is lowered, and CTF_CAP_LIMIT is deliberately
// raised: a bot capture that ENDED the match would freeze tryTouchFlag for the reset
// dwell and strand the flag tests waiting on a rule that is switched off.
//
// TIMEOUTS ARE SOFT AND LARGE ON PURPOSE. A bot walks at 9.4 u/s and CTF-Face is ~260
// units across, so the run from a spawn to the enemy stand is a genuine ~17-20 seconds
// and a bot that gets shot on the way starts over. Every wait below is therefore sized
// for "eventually", and the assertions are about flag ACTIVITY rather than a scripted
// outcome — a bot that captured instead of dying, or died instead of capturing, has not
// failed a test, it has played a different round.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

// The bots' OWN name table, not a copy of it. bots.js is CommonJS (the server has no
// ESM), so it comes in through createRequire — requiring it only evaluates the module's
// constants; createBots is never called here.
const require = createRequire(import.meta.url);
const { BOT_NAMES } = require("../bots.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(HERE, "..", "server.js");
const REPO_ROOT = path.join(HERE, "..", "..");

// Above ctf.test.mjs's own 8751 block, and stepped if busy — this repo gets worked on by
// several processes at once and a stale listener must not fail the suite for a reason
// that has nothing to do with bots.
const BASE_PORT = Number(process.env.BOTS_TEST_PORT) || 8761;
let PORT = BASE_PORT;

// ---- server knobs -------------------------------------------------------------------
const MIN_PER_TEAM = 1; // an empty server owes each side exactly one bot
const BOTS_MAX = 4;
const ROSTER_MS = 500; // roster reacts within a sweep or two instead of 3s
const BRAIN_MS = 250;
const CAP_LIMIT = 5; // HIGH, not low — see the header
const AUTO_RETURN_MS = 3000; // a dropped flag comes home fast, so bots re-attack
const MATCH_RESET_MS = 1000;

// The server's own plausibility ceiling, restated here for the same reason ctf.test.mjs
// restates it: this is the number a cheating client is measured against, and a bot that
// exceeded it would be a bot the anti-cheat should have kicked.
const MAX_POSE_SPEED = 100;
// A bot runs at GROUND_SPEED (9.4 u/s) and never falls — the walkable graph's edges are
// Epic's own connections and the steering caps its step at the remaining distance. 2.5x
// that is a generous ceiling that still fails loudly if the steering ever starts
// producing motion no human rig could.
const HUMANLIKE_SPEED = 9.4 * 2.5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
// "Loque", or "Loque_3f" once every name in the table is taken.
const isBotName = (n) => BOT_NAMES.includes(n) || BOT_NAMES.some((b) => n.startsWith(`${b}_`));

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
    env.BOTS_ENABLED = "1";
    // The suite predates the human gate and drives bots with scripted sockets
    // that come and go; gate semantics get their own dedicated test below.
    env.BOTS_NEED_HUMAN = process.env.BOTS_TEST_NEED_HUMAN || "0";
    env.BOTS_MIN_PER_TEAM = String(MIN_PER_TEAM);
    env.BOTS_MAX = String(BOTS_MAX);
    env.BOTS_ROSTER_MS = String(ROSTER_MS);
    env.BOTS_BRAIN_MS = String(BRAIN_MS);
    env.CTF_CAP_LIMIT = String(CAP_LIMIT);
    env.CTF_AUTO_RETURN_MS = String(AUTO_RETURN_MS);
    env.CTF_MATCH_RESET_MS = String(MATCH_RESET_MS);
    // Plain ws, never TLS: an inherited SSL_CERT/SSL_KEY would silently turn this into a
    // wss server and every client below would fail to connect for the wrong reason.
    delete env.SSL_CERT;
    delete env.SSL_KEY;

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

function connect(name, { spectate = false } = {}) {
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
      alive: true,
      log: [],
      waiters: [],
      pos: { x: 0, y: 0, z: 0 },
      send(msg) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
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
          c.send({ type: "setName", name });
          // Adopt the point the server already picked, exactly as the browser client
          // does — the shooting below is judged against the SERVER's copy of where we
          // are, and hello.spawn is that copy.
          c.pos = { x: m.spawn.x, y: m.spawn.y, z: m.spawn.z };
          c.send({ type: "spawn" });
        }
        clearTimeout(timer);
        resolve(c);
      }
      // Track our own life, so the shooting loop in test 4 never fires from a corpse
      // (canHit refuses a dead shooter, and every shot would be silently dropped).
      if (m.type === "death" && m.id === c.id) c.alive = false;
      if (m.type === "respawn" && m.player && m.player.id === c.id) {
        c.alive = true;
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

function waitFor(c, pred, { timeout = 5000, from = 0, what = "message" } = {}) {
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
      const counts = {};
      for (const m of c.log.slice(from)) counts[m.type] = (counts[m.type] || 0) + 1;
      reject(
        new Error(
          `${c.name}: timed out after ${timeout}ms waiting for ${what}; saw ${JSON.stringify(counts)}`
        )
      );
    }, timeout);
    c.waiters.push(w);
  });
}

// ---------------------------------------------------------------- the witness

// One spectator watches the whole run and keeps two books that no single test could keep
// on its own: who is on the roster, and who is carrying each flag. Both are needed for
// the invariant test 5 is really about — a `leave` must never arrive while the leaver is
// still the recorded carrier of a flag, because server/bots.js's removeBot() drops the
// flag BEFORE it broadcasts the leave, and the two messages travel the same socket in
// that order.
let witness = null;
const roster = new Map(); // id -> {name, team}
const joinOrder = []; // ids, oldest first — "the newest bot on this team" is the last match
const carrier = { red: null, blue: null }; // flag team -> player id holding it
const ghostViolations = [];

function watchWorld(spec) {
  const apply = (m) => {
    switch (m.type) {
      case "hello":
        for (const p of m.players) {
          roster.set(p.id, { name: p.name, team: p.team });
          joinOrder.push(p.id);
        }
        for (const f of m.ctf.flags) carrier[f.team] = f.carrier || null;
        break;
      case "join":
        roster.set(m.player.id, { name: m.player.name, team: m.player.team });
        joinOrder.push(m.player.id);
        break;
      case "leave": {
        // THE INVARIANT. If this id still holds a flag, the flag has just gone out of the
        // match on the back of a player nobody can shoot: no drop, no return timer, no
        // second half.
        for (const team of ["red", "blue"]) {
          if (carrier[team] === m.id) {
            const who = roster.get(m.id);
            ghostViolations.push(
              `${who ? who.name : m.id} left while still carrying the ${team} flag`
            );
          }
        }
        roster.delete(m.id);
        break;
      }
      case "name": {
        // A human's join broadcast carries the placeholder name it was given at
        // connection; the rename lands a message later. Keep the book current so
        // isBotName() is never asked about a stale one.
        const p = roster.get(m.id);
        if (p) p.name = m.name;
        break;
      }
      case "flag":
        carrier[m.team] = m.state === "carried" ? m.carrier : null;
        // A flag can only ever be on a player the world knows about.
        if (carrier[m.team] && !roster.has(carrier[m.team])) {
          ghostViolations.push(`the ${m.team} flag is carried by unknown player ${carrier[m.team]}`);
        }
        break;
      default:
        break;
    }
  };
  // Everything already in the log (the hello), then everything that follows.
  for (const m of spec.log) apply(m);
  spec.ws.on("message", (buf) => {
    let m;
    try {
      m = JSON.parse(buf.toString());
    } catch {
      return;
    }
    apply(m);
  });
}

const botsOn = (team) =>
  joinOrder.filter((id) => {
    const p = roster.get(id);
    return p && p.team === team && isBotName(p.name);
  });
const newestBotOn = (team) => {
  const ids = botsOn(team);
  return ids.length ? ids[ids.length - 1] : null;
};

// Wait until neither flag is on anybody's back. A carrier is deliberately never chosen
// for removal (bots.js removableOn skips it), so a test that wants a bot pushed off the
// roster has to start from a clean board or it is testing the protection instead.
async function waitFlagsIdle(timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (!carrier.red && !carrier.blue) return true;
    await sleep(200);
  }
  return false;
}

// ---------------------------------------------------------------- suite state

let humanRed = null; // the human that ends up on red, used for the shooting test
let victimBotId = null;

before(async () => {
  PORT = await pickPort();
  if (PORT !== BASE_PORT) console.log(`# port ${BASE_PORT} was busy — running the server on ${PORT}`);
  await startServer();
  // Straight away, BEFORE server.js's 500 ms world sweep has run once: the first roster
  // fill happens on that first sweep, so connecting now is what makes the bots' `join`
  // broadcasts observable rather than something we can only find already-done in `hello`.
  witness = await connect("SPEC", { spectate: true });
  watchWorld(witness);
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

// ---------------------------------------------------------------- 1. the roster fills

test("an empty server fills itself with one bot per team, joining on the wire like humans", async () => {
  assert.deepEqual(
    witness.hello.players,
    [],
    "the spectator connected after the first roster sweep — the join broadcasts below cannot be observed. " +
      "Re-run; if this is persistent, server.js's world sweep is firing before its listen callback."
  );

  // Two joins, from nobody's socket. These are ordinary `join` broadcasts carrying an
  // ordinary publicPlayer — a client cannot tell them from a human arriving.
  const joins = [];
  const from = witness.mark();
  for (let i = 0; i < 2; i++) {
    const m = await waitFor(witness, (x) => x.type === "join" && !joins.some((j) => j.player.id === x.player.id), {
      timeout: 8000,
      from,
      what: `bot join #${i + 1}`,
    });
    joins.push(m);
  }

  const teams = joins.map((j) => j.player.team).sort();
  assert.deepEqual(teams, ["blue", "red"], `expected one bot per team, got ${JSON.stringify(teams)}`);
  for (const j of joins) {
    const p = j.player;
    assert.ok(isBotName(p.name), `${p.name} is not from the bot roster`);
    assert.equal(p.hp, 100, `${p.name} joined with hp ${p.hp}`);
    assert.equal(p.flag, null);
    assert.equal(p.kills, 0);
  }
  const names = joins.map((j) => j.player.name);
  assert.notEqual(names[0], names[1], "both bots took the same name");

  // ---- the pose stream ----
  // Sampled over three seconds of ordinary play, per bot. A pair of consecutive poses is
  // dropped if a death or a respawn fell between them: a respawn is a server-side
  // teleport (teamSpawn), it is legitimate for humans too, and measuring across it would
  // be measuring the spawn and not the walk.
  const botIds = joins.map((j) => j.player.id);
  const last = new Map();
  const gaps = { [botIds[0]]: [], [botIds[1]]: [] };
  const speeds = { [botIds[0]]: [], [botIds[1]]: [] };
  let maxSpeed = 0;

  const onMsg = (buf) => {
    let m;
    try {
      m = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if ((m.type === "death" && botIds.includes(m.id)) || (m.type === "respawn" && botIds.includes(m.player?.id))) {
      last.delete(m.type === "death" ? m.id : m.player.id); // baseline is stale across a teleport
      return;
    }
    if (m.type !== "pose" || !botIds.includes(m.id)) return;
    const prev = last.get(m.id);
    last.set(m.id, m);
    if (!prev) return;
    const dt = (m.t - prev.t) / 1000;
    if (dt <= 0) return;
    gaps[m.id].push(m.t - prev.t);
    const v = dist3(m, prev) / dt;
    speeds[m.id].push(v);
    if (v > maxSpeed) maxSpeed = v;
  };
  witness.ws.on("message", onMsg);
  await sleep(3000);
  witness.ws.off("message", onMsg);

  for (const id of botIds) {
    const who = roster.get(id);
    const g = gaps[id];
    // A human's pose loop ticks at 50 ms (POSE_UPDATE_INTERVAL in network.js), and the
    // server re-broadcasts only what actually changed. 15 samples in 3 s is the floor for
    // "this thing is streaming", not the target.
    assert.ok(g.length >= 15, `${who.name}: only ${g.length} pose broadcasts in 3s — that is not a live stream`);
    const sorted = [...g].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    assert.ok(
      median >= 20 && median <= 250,
      `${who.name}: median pose gap ${median}ms is not a human-like cadence (expected ~50ms)`
    );
    const worst = Math.max(...speeds[id]);
    // The rule the anti-cheat holds a client to. A bot that broke it would be a bot the
    // server should have disbelieved.
    assert.ok(worst < MAX_POSE_SPEED, `${who.name}: ${worst.toFixed(1)} u/s between poses exceeds MAX_POSE_SPEED`);
    // And the tighter one: it is supposed to be RUNNING, not sliding.
    assert.ok(
      worst < HUMANLIKE_SPEED,
      `${who.name}: ${worst.toFixed(1)} u/s is faster than a player can run (GROUND_SPEED 9.4)`
    );
    assert.ok(worst > 0.5, `${who.name}: never actually moved (max ${worst.toFixed(2)} u/s)`);
  }
  console.log(`# pose stream: max ${maxSpeed.toFixed(2)} u/s across both bots (ceiling ${MAX_POSE_SPEED})`);
});

// ---------------------------------------------------------------- 2. the bots play

test("bots run the flags: a take, and then something happens to it", async () => {
  const from = witness.mark();
  // ~17-20 s of running from a spawn to the enemy stand, and a bot that gets shot on the
  // way starts the trip again. This waits for the OUTCOME, not for a schedule.
  const taken = await waitFor(witness, (m) => m.type === "flag" && m.event === "taken", {
    timeout: 90000,
    from,
    what: "a bot to take a flag",
  });
  assert.ok(isBotName(taken.byName), `the flag was taken by ${taken.byName}, who is not a bot`);
  assert.equal(taken.state, "carried");
  assert.equal(taken.carrier, taken.by);
  // A flag is only ever taken by the OTHER side — the whole rule set, reached through
  // the same tryTouchFlag() a client's touchFlag message goes through.
  assert.notEqual(taken.byTeam, taken.team, "a bot took its own flag");

  const after = witness.mark();
  // Deliberately not a specific outcome: captured, returned by the defence, dropped on
  // death, or timed home by the auto-return are all a match being played.
  const next = await waitFor(
    witness,
    (m) => m.type === "flag" && m.team === taken.team && ["captured", "returned", "dropped"].includes(m.event),
    { timeout: 90000, from: after, what: `the ${taken.team} flag to be captured, returned or dropped` }
  );
  console.log(`# ${taken.byName} took the ${taken.team} flag; it was ${next.event} ${next.by ? `by ${next.byName}` : "(timed out)"}`);
  assert.notEqual(next.state, "carried", "the flag is still on the same back");
});

// ---------------------------------------------------------------- 3. humans push bots out

test("a human joining red pushes the newest red bot off the roster", async () => {
  // Start from a clean board — a bot mid-run is deliberately protected from removal, and
  // this test is about the roster rule, not about that protection (test 5 is).
  assert.ok(await waitFlagsIdle(), "both flags were still in play after 60s");

  // Team assignment is the server's to make (smaller side, alternating on a tie), so
  // "join red" means "keep joining until one lands on red" — and every human that joins
  // must push its OWN side's newest bot out on the way, which is the rule under test.
  let human = null;
  for (let i = 0; i < 3 && !human; i++) {
    const before = witness.mark();
    const c = await connect(`HUMAN_${i}`);
    const expected = newestBotOn(c.team);
    assert.ok(expected, `no bot on ${c.team} for ${c.name} to displace`);
    const expectedName = roster.get(expected).name;

    // ROSTER_MS after the join at the latest: humans + bots (1 + 1) now exceeds
    // BOTS_MIN_PER_TEAM (1), so the newest bot on that side is shown the door.
    await waitFor(witness, (m) => m.type === "leave" && m.id === expected, {
      timeout: 10000,
      from: before,
      what: `${expectedName} (newest ${c.team} bot) to leave for ${c.name}`,
    });
    console.log(`# ${c.name} joined ${c.team}; ${expectedName} left`);
    assert.equal(botsOn(c.team).length, 0, `${c.team} still has a bot after a human filled the minimum`);
    if (c.team === "red") human = c;
  }
  assert.ok(human, "three humans joined and none of them landed on red");
  humanRed = human;

  // The other side is untouched: its minimum is still owed to a bot.
  assert.equal(botsOn("blue").length, 1, "the blue bot was removed by a human joining red");
});

// ---------------------------------------------------------------- 4. a human kills a bot

test("a human can shoot a bot, and the bot dies and respawns like any player", async () => {
  // Drop every human that is not on red, so the side the target is on owes its minimum
  // to a bot again and there is exactly one bot left alive to shoot at.
  for (const c of allClients) {
    if (c === witness || c === humanRed || c.spectator) continue;
    if (c.ws.readyState === WebSocket.OPEN) await c.close();
  }
  // The roster is a side book kept by watchWorld, not a message in the log, so this is a
  // poll rather than a waitFor: within a sweep or two the blue side is one short of its
  // minimum again and the manager fills it.
  const refilled = Date.now() + 15000;
  while (Date.now() < refilled && botsOn("blue").length !== 1) await sleep(200);
  assert.equal(
    botsOn("blue").length,
    1,
    `expected exactly one blue bot to shoot at, roster is ${JSON.stringify([...roster.values()])}`
  );
  victimBotId = newestBotOn("blue");
  const victimName = roster.get(victimBotId).name;

  // Five hits of the server's fixed 20 damage, fired first and claimed right behind —
  // the server makes every hit pay for itself with a recent shot from the same player,
  // exactly as in ctf.test.mjs. Repeated because the bot shoots back: a dead shooter's
  // hits are refused by canHit, so a round that gets us killed simply does not land.
  const from = witness.mark();
  let sawOurHit = false;
  const deadline = Date.now() + 45000;
  const dead = () => witness.log.slice(from).some((m) => m.type === "death" && m.id === victimBotId);

  while (Date.now() < deadline && !dead()) {
    if (!humanRed.alive) {
      await sleep(200);
      continue;
    }
    for (let i = 0; i < 5 && humanRed.alive; i++) {
      humanRed.send({ type: "fire", origin: { ...humanRed.pos }, dir: { x: 1, y: 0, z: 0 } });
      await sleep(30);
      humanRed.send({ type: "clientHit", victimId: victimBotId });
      await sleep(95);
    }
    await sleep(50);
    sawOurHit =
      sawOurHit ||
      witness.log.slice(from).some((m) => m.type === "hit" && m.victimId === victimBotId && m.by === humanRed.id);
  }

  // The damage itself, on the wire, attributed to the human: applyHit does not care that
  // the victim has no socket.
  assert.ok(sawOurHit, `no 'hit' on ${victimName} was ever credited to ${humanRed.name}`);
  const death = await waitFor(witness, (m) => m.type === "death" && m.id === victimBotId, {
    timeout: 5000,
    from,
    what: `the death of ${victimName}`,
  });
  assert.equal(death.by, humanRed.id, `${victimName} was killed by ${death.by}, not by the human`);
  // The kill is scored for the human on the same scoreboard everyone else is on.
  const score = await waitFor(
    witness,
    (m) => m.type === "highscore-update" && m.players.some((p) => p.id === humanRed.id && p.kills >= 1),
    { timeout: 5000, from, what: "the human's kill on the scoreboard" }
  );
  assert.ok(score.players.some((p) => p.id === victimBotId), "the dead bot fell off the scoreboard");

  // And back on its feet: applyHit's respawn timer works unchanged for a player with no
  // socket, because it only ever looks the victim up in `players` and broadcasts.
  const rez = await waitFor(witness, (m) => m.type === "respawn" && m.player && m.player.id === victimBotId, {
    timeout: 8000,
    from,
    what: `the respawn of ${victimName}`,
  });
  assert.equal(rez.player.hp, 100, `${victimName} respawned on ${rez.player.hp} hp`);
  assert.equal(rez.player.flag, null);
  assert.equal(rez.player.dual, false);
  assert.ok(roster.has(victimBotId), "the bot was removed rather than respawned");
  console.log(`# ${humanRed.name} killed ${victimName}, who respawned on ${rez.player.hp} hp`);
});

// ---------------------------------------------------------------- 5. the flag comes back

test("a bot never carries a flag off the roster with it", async () => {
  // Wait for the blue bot to actually be holding the red flag. That is a ~20s run each
  // time, and it may die on the way and start over.
  const until = Date.now() + 120000;
  let holder = null;
  while (Date.now() < until && !holder) {
    for (const team of ["red", "blue"]) {
      const c = carrier[team];
      if (c && roster.has(c) && isBotName(roster.get(c).name)) holder = { id: c, team };
    }
    if (!holder) await sleep(200);
  }
  assert.ok(holder, "no bot got its hands on a flag within 120s");
  const holderName = roster.get(holder.id).name;
  console.log(`# ${holderName} is carrying the ${holder.team} flag — now crowding it off the roster`);

  // Force the removal pressure: keep joining humans until one lands on the carrier's own
  // side, at which point humans + bots exceeds BOTS_MIN_PER_TEAM and the sweep wants a
  // bot gone. (Team assignment is the server's; the smaller-side rule makes this
  // converge in at most a couple of joins.)
  const holderTeam = roster.get(holder.id).team;
  const from = witness.mark();
  let crowded = false;
  for (let i = 0; i < 4 && !crowded; i++) {
    const c = await connect(`CROWD_${i}`);
    if (c.team === holderTeam) crowded = true;
  }
  assert.ok(crowded, `could not put a human on ${holderTeam} to crowd ${holderName} out`);

  // THE ASSERTION. removeBot() calls dropFlag() before it broadcasts the leave, and
  // removableOn() will not even pick a carrier — so by the time this bot's `leave`
  // arrives, the flag must already have moved on. Either ordering satisfies the rule the
  // test exists for: the flag must never leave the match on a ghost's back.
  const leave = await waitFor(witness, (m) => m.type === "leave" && m.id === holder.id, {
    timeout: 90000,
    from,
    what: `${holderName} to be crowded off the roster`,
  });
  assert.ok(leave, "unreachable");

  // The flag event that ended the carry came FIRST, on this same socket. Anchored on the
  // last message that put the flag IN this bot's hands, so an unrelated earlier event for
  // the same flag cannot stand in for the one that matters.
  const idx = witness.log.findIndex((m) => m === leave);
  const flagsBefore = witness.log.slice(0, idx).filter((m) => m.type === "flag" && m.team === holder.team);
  const took = flagsBefore.map((m) => m.carrier).lastIndexOf(holder.id);
  assert.ok(took >= 0, `no record of ${holderName} ever taking the ${holder.team} flag`);
  const released = flagsBefore.slice(took + 1).find((m) => m.carrier !== holder.id);
  assert.ok(
    released,
    `${holderName} left while the last word on the ${holder.team} flag was still that it was carrying it`
  );
  assert.ok(
    ["captured", "returned", "dropped"].includes(released.event),
    `the ${holder.team} flag left ${holderName} via an unexpected event: ${released.event}`
  );
  assert.notEqual(
    carrier[holder.team],
    holder.id,
    `the ${holder.team} flag is still recorded as carried by ${holderName}, who is gone`
  );

  // The invariant, over the WHOLE run rather than just this moment: no leave, from any
  // player, human or bot, ever landed while that player still held a flag.
  assert.deepEqual(ghostViolations, [], "a flag was carried off by a player who left");

  // Finally, the world as a fresh client is told it: every carried flag is on somebody
  // who is actually in the game. A ghost carrier would show up here as a flag held by an
  // id that is in no `players` row.
  const late = await connect("LATE_SPEC", { spectate: true });
  for (const f of late.hello.ctf.flags) {
    if (!f.carrier) continue;
    assert.ok(
      late.hello.players.some((p) => p.id === f.carrier),
      `hello says the ${f.team} flag is carried by ${f.carrier}, who is in nobody's roster`
    );
  }
  console.log(`# ${holderName} left cleanly; the ${holder.team} flag stayed in the match`);
});
