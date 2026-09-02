#!/usr/bin/env node
// measure-lethality.mjs — how hard do the bots actually hit?
//
//   node scripts/measure-lethality.mjs [runsPerConfig] [secondsPerRun]
//
// DEV TOOLING, and in the repo on purpose. Every earlier version of this was a throwaway
// in a session scratchpad, and the last one had a bug that produced CONFIDENTLY WRONG
// numbers for an afternoon (see below). That is not a thing to rewrite from memory a
// third time.
//
// Every number quoted about bot lethality so far has been ONE 180 s sample of 3-15
// deaths. That is enough to order the configurations and not enough to say two of them
// match. This runs each configuration several times, INTERLEAVED so that machine load
// drifting over the hour cannot favour whichever one ran first, and reports the spread.
//
// Two things that broke the single runs and are fixed here:
//   - a free port is chosen per run, rather than a fixed one a previous server may
//     still be holding. Two earlier runs produced nothing at all that way, and one
//     returned "0 deaths, 0 hits", which looks like a result and is not.
//   - the server is killed and WAITED FOR before the next run starts.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire as _cr } from "node:module";
const WebSocket = _cr(import.meta.url)(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "node_modules", "ws"),
);
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(HERE, "..");
const { FLAG_HOMES } = require(path.join(R, "server", "map-actors.js"));

const RUNS = Number(process.argv[2] || 6);
const SECONDS = Number(process.argv[3] || 120);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONFIGS = [
  { name: "terrain rule (shipped)", env: {} },
  {
    name: "walls + dy30 acc.36 r450",
    env: { BOT_LOS: "walls", BOTS_MAX_FIGHT_DY: "30", BOTS_ACCURACY: "0.36", BOTS_REACTION_MS: "450" },
  },
];

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function oneRun(cfg) {
  const PORT = await freePort();
  const env = { ...process.env, PORT: String(PORT), ...cfg.env };
  delete env.SSL_CERT;
  delete env.SSL_KEY;
  const child = spawn(process.execPath, [path.join(R, "server", "server.js")], {
    cwd: R,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => (out += d));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => (out += d));
  const started = await Promise.race([
    new Promise((r) => {
      const t = setInterval(() => {
        if (/server on :/.test(out)) {
          clearInterval(t);
          r(true);
        }
      }, 50);
    }),
    sleep(15000).then(() => false),
  ]);
  if (!started) {
    child.kill("SIGKILL");
    return null;
  }

  // A SECOND connection, purely to watch. The server does not echo a pose back to the
  // client that sent it, so without a witness the dummy cannot tell an accepted move from
  // a refused one — and it refuses the first hop of every life, because dt is measured
  // from the last ACCEPTED pose and a client that has never sent one gets it clamped to
  // 0.02, a budget of about eight units. The first version of this harness walked in its
  // own imagination and reported time "at the post" it had never reached.
  const witness = new WebSocket(`ws://127.0.0.1:${PORT}/?spectate=1`);
  const seenPoses = [];
  witness.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "pose") seenPoses.push(m);
  });
  await new Promise((r) => witness.on("open", r));

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
  let me = null, spawnPt = null, aliveSince = 0, post = null, walking = false;
  const lives = [];
  let hits = 0;
  let poseTimer = null;
  // Time spent STANDING at the post, as opposed to walking back to it after a respawn.
  // Hits per wall-clock second is unfair to the deadlier configuration: killing you more
  // sends you on more walks, and you cannot be shot at the post while crossing the map.
  // This is the denominator that actually means "under fire".
  let exposedMs = 0;
  let exposedSince = 0;
  // Whether the dummy is actually standing at the enemy flag. A run where it never
  // arrived is not a measurement of anything and is thrown away.
  let reached = false;
  let arrivals = 0;
  let attempts = 0;

  // Walk to the enemy flag and stand there. The worst case on purpose: hitChance's
  // motion term is at its maximum against a target that is not moving.
  async function walkTo(dest) {
    if (exposedSince) {
      exposedMs += Date.now() - exposedSince;
      exposedSince = 0;
    }
    walking = true;
    // Prime the clock: stand still deliberately, so the next hop is measured against a
    // pose the server accepted rather than against nothing.
    ws.send(JSON.stringify({ type: "pose", ...spawnPt, ry: 0, speed: 0 }));
    await sleep(1150);
    for (let g = 0; g < 16; g++) {
      const dx = dest.x - spawnPt.x, dy = dest.y - spawnPt.y, dz = dest.z - spawnPt.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 1.5) break;
      const step = Math.min(1, 80 / d);
      const next = { x: spawnPt.x + dx * step, y: spawnPt.y + dy * step, z: spawnPt.z + dz * step };
      const from = seenPoses.length;
      ws.send(JSON.stringify({ type: "pose", ...next, ry: 0, speed: 0 }));
      await sleep(1150);
      // Only believe the move if the witness saw it. Otherwise stay where we were and
      // try the same hop again — the pose was refused, not applied.
      const landed = seenPoses
        .slice(from)
        .find((m) => m.id === me && Math.hypot(m.x - next.x, m.z - next.z) < 1.5);
      if (landed) spawnPt = { x: landed.x, y: landed.y, z: landed.z };
    }
    attempts++;
    reached = Math.hypot(spawnPt.x - dest.x, spawnPt.z - dest.z) < 4;
    if (reached) arrivals++;
    walking = false;
    exposedSince = Date.now();
  }

  ws.on("open", () => ws.send(JSON.stringify({ type: "setName", name: "Dummy" })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "hello") {
      me = m.yourId;
      spawnPt = { ...m.spawn };
      post = FLAG_HOMES[m.team === "red" ? "blue" : "red"];
      ws.send(JSON.stringify({ type: "spawn" }));
      aliveSince = Date.now();
      poseTimer = setInterval(() => {
        if (!walking) ws.send(JSON.stringify({ type: "pose", ...spawnPt, ry: 0, speed: 0 }));
      }, 200);
      walkTo(post);
    } else if (m.type === "hit" && m.victimId === me) hits++;
    else if (m.type === "death" && m.id === me) lives.push(Date.now() - aliveSince);
    else if (m.type === "respawn" && m.player && m.player.id === me) {
      spawnPt = { x: m.player.x, y: m.player.y, z: m.player.z };
      aliveSince = Date.now();
      walkTo(post);
    }
  });

  await sleep(SECONDS * 1000);
  if (exposedSince) {
    exposedMs += Date.now() - exposedSince;
    exposedSince = 0;
  }
  if (poseTimer) clearInterval(poseTimer);
  try { ws.close(); } catch {}
  try { witness.close(); } catch {}
  child.kill("SIGKILL");
  await new Promise((r) => child.on("exit", r));
  await sleep(400); // let the port go
  if (!me) return null; // never got in — not a result
  if (!attempts || arrivals / attempts < 0.5) return null; // never reached the post
  const exposed = Math.max(1, exposedMs / 1000);
  return {
    deaths: lives.length,
    hitsPerSec: hits / SECONDS,
    hitsPerExposed: hits / exposed,
    exposed,
    arrivals,
    attempts,
    lives,
  };
}

const stats = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1));
  return { mean, sd, min: s[0], max: s[s.length - 1], median: s[s.length >> 1] };
};

const results = new Map(CONFIGS.map((c) => [c.name, []]));
console.log(`${CONFIGS.length} configs x ${RUNS} runs x ${SECONDS}s, interleaved. ~${Math.round((CONFIGS.length * RUNS * (SECONDS + 6)) / 60)} min.\n`);
for (let r = 0; r < RUNS; r++) {
  for (const cfg of CONFIGS) {
    const got = await oneRun(cfg);
    if (!got) {
      console.log(`  run ${r + 1} ${cfg.name}: FAILED to start or connect — discarded`);
      continue;
    }
    results.get(cfg.name).push(got);
    console.log(
      `  run ${r + 1} ${cfg.name.padEnd(26)} ${String(got.deaths).padStart(3)} deaths  ` +
        `${got.hitsPerSec.toFixed(3)}/s wall  ${got.hitsPerExposed.toFixed(3)}/s exposed  ` +
        `(${got.exposed.toFixed(0)}s of ${SECONDS}s at the post)`,
    );
  }
}

console.log("\n=== incoming hits per second AT THE POST (the fair denominator) ===");
for (const [name, runs] of results) {
  if (!runs.length) { console.log(`  ${name}: no valid runs`); continue; }
  const e = stats(runs.map((x) => x.hitsPerExposed));
  const w = stats(runs.map((x) => x.hitsPerSec));
  const d = stats(runs.map((x) => x.deaths));
  const x = stats(runs.map((x) => x.exposed));
  console.log(
    `  ${name.padEnd(26)} n=${runs.length}\n` +
      `      exposed  ${e.mean.toFixed(3)} +/- ${e.sd.toFixed(3)} hits/s  (${e.min.toFixed(3)}..${e.max.toFixed(3)})\n` +
      `      wall     ${w.mean.toFixed(3)} +/- ${w.sd.toFixed(3)} hits/s\n` +
      `      deaths   ${d.mean.toFixed(1)} +/- ${d.sd.toFixed(1)}   time at the post ${x.mean.toFixed(0)}s of ${SECONDS}s`,
  );
}
process.exit(0);
