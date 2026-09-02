// headshot.test.mjs — the one damage number a client has any say in.
//
// A hitscan shot is resolved on the client; that is what makes it feel instant. The
// server checks the claim it gets back — victim alive, in range, and a shot fired to pay
// for it — and until now that was enough, because the damage was the same wherever it
// landed. A headshot changes that: the server now needs to know WHERE, and where is
// something only the client saw.
//
// So the point is a claim, checked twice: it has to lie on the ray of the shot being
// spent, and inside the victim. A point that fails either is not an error and not a kick
// — it is a BODY hit, so the worst a flattering lie can do is cost the liar their bonus.
// That last property is the one worth a test, because it is the one that would rot.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WEAPONS, PAWN } = require("../weapons.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(HERE, "..", "server.js");
const REPO_ROOT = path.join(HERE, "..", "..");

// 8801: 8751 CTF, 8761 bots, 8781 announcer, 8791 bot gate. `node --test` runs these
// files in parallel, so every suite needs its own.
let PORT = 8801;
let child = null;
const clients = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort(from) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(from, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on("error", () => resolve(freePort(from + 1)));
  });
}

before(async () => {
  PORT = await freePort(Number(process.env.HEADSHOT_TEST_PORT) || 8801);
  const env = { ...process.env, PORT: String(PORT), BOTS_ENABLED: "0" };
  delete env.SSL_CERT;
  delete env.SSL_KEY;
  const log = [];
  await new Promise((resolve, reject) => {
    child = spawn(process.execPath, [SERVER_JS], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => reject(new Error(`server never started\n${log.join("")}`)), 10000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      log.push(d);
      if (/server on :/.test(d)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => log.push(d));
  });
});

after(() => {
  for (const c of clients) try { c.ws.close(); } catch {}
  if (child) child.kill("SIGKILL");
});

function connect(name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    const c = { name, ws, id: null, seen: [], pos: null, hp: 100 };
    clients.push(c);
    ws.on("open", () => ws.send(JSON.stringify({ type: "setName", name })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      c.seen.push(m);
      if (m.type === "hello") {
        c.id = m.yourId;
        c.pos = m.spawn;
        ws.send(JSON.stringify({ type: "spawn" }));
        resolve(c);
      } else if (m.type === "world" || m.type === "pickups-init") {
        c.world = m;
      }
    });
  });
}

/**
 * Walk a player to a point, the long way round.
 *
 * The server caps plausible motion at MAX_POSE_SPEED over a dt that clamps to one second,
 * so a client covers at most about a hundred units per hop and only after pausing a full
 * second since its last accepted pose. A single jump to a pickup halfway across CTF-Face
 * is silently REJECTED, which leaves the player on their spawn and makes a perfectly good
 * headshot rule look broken — which is exactly how this test failed first time round.
 *
 * Each hop is confirmed by watching another client for the resulting broadcast, because
 * the server does not echo a pose back to whoever sent it.
 */
async function moveTo(mover, witness, dest) {
  const HOP = 90;
  // Prime the clock. dt is measured from the last ACCEPTED pose, and a client that has
  // never sent one gets dt clamped to 0.02 — a budget of about eight units. So stand
  // still first, deliberately, and let a full second pass before trying to cover ground.
  mover.ws.send(JSON.stringify({ type: "pose", ...mover.pos, ry: 0, speed: 0 }));
  await sleep(200);
  for (let guard = 0; guard < 12; guard++) {
    const dx = dest.x - mover.pos.x;
    const dy = dest.y - mover.pos.y;
    const dz = dest.z - mover.pos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.4) return;
    const step = Math.min(1, HOP / dist);
    const next = {
      x: mover.pos.x + dx * step,
      y: mover.pos.y + dy * step,
      z: mover.pos.z + dz * step,
    };
    await sleep(1100);
    const from = witness.seen.length;
    mover.ws.send(JSON.stringify({ type: "pose", ...next, ry: 0, speed: 0 }));
    const deadline = Date.now() + 2000;
    let landed = null;
    while (Date.now() < deadline && !landed) {
      landed = witness.seen
        .slice(from)
        .find((m) => m.type === "pose" && m.id === mover.id && Math.hypot(m.x - next.x, m.z - next.z) < 1);
      if (!landed) await sleep(50);
    }
    assert.ok(landed, `${mover.name} could not move to ${JSON.stringify(next)} — pose refused`);
    mover.pos = { x: landed.x, y: landed.y, z: landed.z };
  }
  throw new Error(`${mover.name} never reached ${JSON.stringify(dest)}`);
}

/** Fire at a point and return the hits the server actually applied. */
async function shootAt(shooter, victim, point, spectator) {
  const from = spectator.seen.length;
  const origin = { ...shooter.pos };
  // The direction is derived FROM the point, so the claim sits honestly on its own ray.
  // A test that fired one way and claimed a hit somewhere else would only ever be
  // measuring the rejection path.
  const dir = { x: point.x - origin.x, y: point.y - origin.y, z: point.z - origin.z };
  shooter.ws.send(JSON.stringify({ type: "fire", origin, dir }));
  await sleep(40);
  shooter.ws.send(JSON.stringify({ type: "clientHit", victimId: victim.id, point }));
  await sleep(200);
  const hits = spectator.seen
    .slice(from)
    .filter((m) => m.type === "hit" && m.victimId === victim.id);
  assert.ok(hits.length, "no hit was applied at all");
  return hits;
}

test("a sniper headshot is 100 and a body shot is 45, and a lie is worth 45", async () => {
  const shooter = await connect("Sniper");
  const target = await connect("Target");
  await sleep(300);

  // The nearest Sniper Rifle to the shooter's spawn, so the walk is short.
  const pickups = shooter.seen.find((m) => m.type === "hello")?.pickups || [];
  const rifle = pickups
    .filter((p) => p.type === "weapon-sniper")
    .sort(
      (a, b) =>
        Math.hypot(a.x - shooter.pos.x, a.z - shooter.pos.z) -
        Math.hypot(b.x - shooter.pos.x, b.z - shooter.pos.z),
    )[0];
  assert.ok(rifle, "no weapon-sniper on the map");

  // Both to the rifle: the shooter to arm, the target to stand where it can be shot.
  await moveTo(shooter, target, rifle);
  await moveTo(target, shooter, rifle);

  shooter.ws.send(JSON.stringify({ type: "takePickup", id: rifle.id }));
  await sleep(400);
  const armed = shooter.seen.some(
    (m) => m.type === "loadout" && m.id === shooter.id && m.weapon === "sniper",
  );
  assert.ok(armed, "the Sniper Rifle was never picked up");

  const line = target.pos.y + PAWN.height / 2 + PAWN.headshotAboveCentre;
  const overhead = { x: target.pos.x, y: +(line + 0.15).toFixed(2), z: target.pos.z };

  // ABOVE THE LINE. 100 from full health is a kill in one shot and 45 is not, so the
  // death is the assertion — there is no hp left to measure a hundred against.
  let hits = await shootAt(shooter, target, overhead, target);
  assert.equal(
    hits[hits.length - 1].hp,
    0,
    `one headshot left ${hits[hits.length - 1].hp} hp; ${WEAPONS.sniper.headshotDamage} should kill from full`,
  );
  assert.equal(hits.length, 1, `it took ${hits.length} shots, so that was not a headshot`);

  // Back on their feet, and back to the rifle: a respawn puts them on a team spawn.
  await new Promise((resolve) => {
    const deadline = Date.now() + 8000;
    const poll = setInterval(() => {
      const back = target.seen.find((m) => m.type === "respawn" && m.player?.id === target.id);
      if (back) {
        clearInterval(poll);
        target.pos = { x: back.player.x, y: back.player.y, z: back.player.z };
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        resolve();
      }
    }, 100);
  });
  await sleep(300);
  await moveTo(target, shooter, shooter.pos);

  // BELOW THE LINE. The ordinary 45, and no death to complicate the measurement.
  const chest = { x: target.pos.x, y: +(target.pos.y + 0.6).toFixed(2), z: target.pos.z };
  hits = await shootAt(shooter, target, chest, target);
  let dealt = 100 - hits[hits.length - 1].hp;
  assert.equal(dealt, WEAPONS.sniper.damage, `a chest shot dealt ${dealt}`);

  // A POINT NOWHERE NEAR THE BODY, claimed as a headshot. The server takes the shot —
  // it was fired, the victim is alive and in range — but not the claim about where it
  // went. The lie is worth exactly a body hit, which is the whole design.
  const before = hits[hits.length - 1].hp;
  const far = { x: target.pos.x + 40, y: +(line + 0.15).toFixed(2), z: target.pos.z + 40 };
  const from = target.seen.length;
  shooter.ws.send(JSON.stringify({ type: "fire", origin: { ...shooter.pos }, dir: { x: 1, y: 0, z: 0 } }));
  await sleep(40);
  shooter.ws.send(JSON.stringify({ type: "clientHit", victimId: target.id, point: far }));
  await sleep(200);
  const lied = target.seen.slice(from).filter((m) => m.type === "hit" && m.victimId === target.id);
  assert.ok(lied.length, "the shot was dropped entirely; it should still be a body hit");
  dealt = before - lied[lied.length - 1].hp;
  assert.equal(dealt, WEAPONS.sniper.damage, `a bogus headshot claim dealt ${dealt}, not a body hit`);
});
