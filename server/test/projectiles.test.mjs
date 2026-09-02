// projectiles.test.mjs — the three weapons that fly.
//
// These run against the REAL map collision and the REAL weapon table, with only the
// roster and the damage sink faked, because those are the two things the module takes as
// arguments precisely so this could be done without a server, a socket or a clock.
//
// What is worth pinning: a projectile that silently fails to hit anything looks exactly
// like a miss, and one that flies through a wall looks like a long shot. Neither raises
// an error, so both need a test that would have caught them.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createProjectiles } = require("../projectiles.js");
const { WEAPONS, PAWN } = require("../weapons.js");
const mc = require("../map-collision.js");
const surf = require("../navmesh-surface.js");
const { FLAG_HOMES, SPAWNS } = require("../map-actors.js");
const { NODES } = require("../nav-graph.js");

const STEP = 50;

/** A rig with a roster, a damage ledger and a step function. Nothing is stubbed but these. */
function rig(roster) {
  const players = new Map();
  for (const p of roster) {
    players.set(p.id, { hp: 100, armor: 0, team: "red", udamageUntil: 0, ...p });
  }
  const dealt = [];
  const sent = [];
  const projectiles = createProjectiles({
    players,
    broadcast: (m) => sent.push(m),
    damage: (shooter, victim, amount) => {
      dealt.push({ from: shooter.id, to: victim.id, amount });
      victim.hp = Math.max(0, victim.hp - amount);
    },
  });
  let clock = 1_000_000;
  return {
    players,
    dealt,
    sent,
    projectiles,
    now: () => clock,
    fire(shooterId, dir, origin) {
      const s = players.get(shooterId);
      const from = origin ?? { x: s.x, y: s.y + 1.4, z: s.z };
      return projectiles.spawn(s, from, dir, clock);
    },
    run(steps = 100) {
      for (let i = 0; i < steps && projectiles.count() > 0; i++) {
        clock += STEP;
        projectiles.tick(clock);
      }
      return clock;
    },
  };
}

/** A flat patch of ground with room around it: a team spawn, lifted clear of the floor. */
function openGround() {
  const s = SPAWNS.red[0];
  const y = surf.surfaceNear(s.x, s.z, s.y, 4) ?? s.y;
  return { x: s.x, y, z: s.z };
}

test("a rocket crosses the gap and hits for its own damage", () => {
  const a = openGround();
  // Straight down the +x axis, far enough that travel time is real: at 21.15 m/s a
  // 10 m shot takes about half a second, which is ten ticks.
  const b = { x: a.x + 10, y: a.y, z: a.z };
  const r = rig([
    { id: "s", ...a, weapon: "rocket" },
    { id: "v", ...b, weapon: "enforcer", team: "blue" },
  ]);
  assert.notEqual(r.fire("s", { x: 1, y: 0, z: 0 }), null, "the rocket did not launch");
  r.run();
  const direct = r.dealt.find((d) => d.to === "v" && d.amount === WEAPONS.rocket.damage);
  assert.ok(direct, `no ${WEAPONS.rocket.damage}-damage hit landed: ${JSON.stringify(r.dealt)}`);
  assert.equal(r.projectiles.count(), 0, "the rocket should be gone after it hit");
});

test("splash falls off with distance and stops at the radius", () => {
  const a = openGround();
  const near = { x: a.x + 10.5, y: a.y, z: a.z };
  // Just outside the blast: the rocket's radius is 5.17 m measured from the edge of the
  // collision cylinder, so 10 + 5.17 + radius + a margin is comfortably clear.
  const far = { x: a.x + 10 + WEAPONS.rocket.projectile.splashRadius + PAWN.radius + 2, y: a.y, z: a.z };
  const r = rig([
    { id: "s", ...a, weapon: "rocket" },
    { id: "v", x: a.x + 10, y: a.y, z: a.z, weapon: "enforcer", team: "blue" },
    { id: "near", ...near, weapon: "enforcer", team: "blue" },
    { id: "far", ...far, weapon: "enforcer", team: "blue" },
  ]);
  r.fire("s", { x: 1, y: 0, z: 0 });
  r.run();
  const to = (id) => r.dealt.filter((d) => d.to === id).reduce((n, d) => n + d.amount, 0);
  assert.ok(to("v") > 0, "the player it hit took nothing");
  assert.ok(to("near") > 0, "a player inside the blast radius took nothing");
  assert.ok(to("near") < WEAPONS.rocket.damage, "splash at range should be less than a direct hit");
  assert.equal(to("far"), 0, `a player outside the radius took ${to("far")}`);
});

test("you are not immune to your own rocket", () => {
  // UT99's HurtRadius does not exclude the instigator, which is the whole reason firing
  // a rocket at your own feet is a decision.
  const a = openGround();
  const r = rig([{ id: "s", ...a, weapon: "rocket" }]);
  // Straight down, into the floor a metre and a half below the muzzle.
  r.fire("s", { x: 0, y: -1, z: 0 });
  r.run();
  assert.ok(
    r.dealt.some((d) => d.to === "s" && d.amount > 0),
    "the shooter took no splash from a rocket fired at their own feet",
  );
});

test("a rocket stops at a wall instead of flying through the tower", () => {
  // The flag bases cannot see each other — server/test/map-collision.test.mjs pins that.
  // So a rocket fired from one at the other must never reach.
  const from = { x: FLAG_HOMES.red.x, y: FLAG_HOMES.red.y, z: FLAG_HOMES.red.z };
  const to = { x: FLAG_HOMES.blue.x, y: FLAG_HOMES.blue.y, z: FLAG_HOMES.blue.z };
  assert.equal(mc.blocked(from.x, from.y + 1.4, from.z, to.x, to.y + 1.4, to.z), true);
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const r = rig([
    { id: "s", ...from, weapon: "rocket" },
    { id: "v", ...to, weapon: "enforcer", team: "blue" },
  ]);
  r.fire("s", d);
  r.run(400);
  assert.equal(
    r.dealt.some((x) => x.to === "v"),
    false,
    "a rocket got from one flag base to the other",
  );
  assert.equal(r.projectiles.count(), 0, "it should have exploded on the way");
});

test("a ripper blade bounces, and stops bouncing when UT99 says it does", () => {
  // Razor2's HitWall destroys the blade once NumWallHits passes 6.
  //
  // Aiming this needs care. A blade fired at open ground skips off it once and flies
  // away into the sky forever — there is no gravity on a UT99 projectile — so a test
  // that fires into the floor and checks "at most 6 bounces" passes on a single bounce
  // and proves nothing about the cap. Fire it around a spot with walls on several sides
  // instead, and demand that some direction actually reaches the limit.
  const spot = NODES.find((n) => n.name === "PathNode25");
  const ground = surf.surfaceNear(spot.x, spot.z, spot.y, 4);
  assert.notEqual(ground, null, "PathNode25 has no floor to bounce off");

  const cap = WEAPONS.ripper.projectile.bounces;
  let most = 0;
  let cappedRun = false;
  for (let a = 0; a < 360; a += 30) {
    const r = rig([{ id: "s", x: spot.x, y: ground, z: spot.z, weapon: "ripper" }]);
    r.fire("s", { x: Math.cos((a * Math.PI) / 180), y: 0, z: Math.sin((a * Math.PI) / 180) });
    r.run(400);
    const bounces = r.sent.filter((m) => m.type === "projectile-bounce").length;
    most = Math.max(most, bounces);
    assert.ok(bounces <= cap, `${bounces} bounces at ${a} degrees exceeds the ${cap} UT99 allows`);
    // A blade that used its whole budget must have been destroyed for that reason
    // rather than quietly outliving it.
    if (bounces === cap) {
      cappedRun = true;
      assert.equal(r.projectiles.count(), 0, `a blade that bounced ${cap} times is still flying`);
    }
  }
  assert.equal(most, cap, `the best direction only managed ${most} bounces; the cap is never reached`);
  assert.ok(cappedRun, "no direction ever spent the full bounce budget");
});

test("a rocket does not hit the person who fired it in the face", () => {
  // The owner is excluded from DIRECT hits — otherwise every shot detonates on the
  // muzzle, because the shooter's own collision cylinder is right there.
  const a = openGround();
  const r = rig([{ id: "s", ...a, weapon: "rocket" }]);
  r.fire("s", { x: 1, y: 0, z: 0 });
  r.projectiles.tick(r.now() + STEP);
  const direct = r.dealt.find((d) => d.to === "s" && d.amount === WEAPONS.rocket.damage);
  assert.equal(direct, undefined, "the shooter took a direct hit from their own muzzle");
});

test("a hitscan weapon launches nothing", () => {
  const a = openGround();
  const r = rig([{ id: "s", ...a, weapon: "enforcer" }]);
  assert.equal(r.fire("s", { x: 1, y: 0, z: 0 }), null);
  assert.equal(r.projectiles.count(), 0);
});

test("clear() empties the air", () => {
  const a = openGround();
  const r = rig([{ id: "s", ...a, weapon: "rocket" }]);
  r.fire("s", { x: 0, y: 1, z: 0 });
  assert.equal(r.projectiles.count(), 1);
  r.projectiles.clear();
  assert.equal(r.projectiles.count(), 0);
  assert.ok(r.sent.some((m) => m.type === "projectile-gone" && m.why === "reset"));
});
