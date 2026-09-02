// projectiles.js — the three UT99 weapons that do not resolve instantly.
//
// A hitscan shot is decided the moment it is fired and the server only has to agree.
// A rocket is a thing that EXISTS: it leaves the muzzle, crosses the map over half a
// second, and can be outrun, dodged, or blown up in someone's face by the time it
// arrives. That means the server owns it frame by frame, which is why this file needs
// map-collision.js — without walls a rocket flies through the tower and out the far side.
//
// ---------------------------------------------------------------------------
// WHAT IS UT99's AND WHAT IS OURS
// ---------------------------------------------------------------------------
// Speed, damage, splash radius, lifespan and the wall-hit budget all come out of the
// retail package (scripts/dump-ut-projectiles.mjs -> ut-projectiles.json -> weapons.js).
// So does the falloff curve: Razor2Alt's own BlowUp() spells it out as
//
//     damageScale = 1 - FMax(0, (dist - Victims.CollisionRadius) / radius)
//
// which is why splash measures from the edge of the body's collision cylinder rather
// than from its centre, and why a player standing right on top of a rocket takes the
// full number instead of a scaled one.
//
// Ours: the tick rate, and the decision to move a projectile in ONE swept segment per
// tick rather than sampling points along it. A rocket covers a metre per tick and a
// ripper blade one and a half; point sampling at that speed walks straight through a
// body 0.8 m wide often enough to be noticed.
const { raycast } = require("./map-collision.js");
const { weapon, PAWN } = require("./weapons.js");

// 20 Hz, matching the bots' own think rate.
const STEP_MS = 50;
// No projectile survives longer than this whatever its class says. WarShell inherits
// Projectile's LifeSpan of 140 seconds, which is not a thing this server should hold.
const MAX_LIFE_MS = 10000;

/**
 * Where a segment first enters a player's collision cylinder, as a fraction of the
 * segment, or null. The cylinder is upright, so this is a circle test in plan with a
 * height check at the answer.
 */
function sweepCylinder(x0, y0, z0, dx, dy, dz, cx, cy, cz, radius, height) {
  const mx = x0 - cx;
  const mz = z0 - cz;
  const a = dx * dx + dz * dz;
  const b = 2 * (mx * dx + mz * dz);
  const c = mx * mx + mz * mz - radius * radius;

  let t;
  if (a < 1e-12) {
    // Travelling straight up or down: either it is already inside the circle or it never
    // will be.
    if (c > 0) return null;
    t = 0;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const root = Math.sqrt(disc);
    const t0 = (-b - root) / (2 * a);
    const t1 = (-b + root) / (2 * a);
    t = t0 >= 0 ? t0 : t1;
    if (t < 0 || t > 1) return null;
  }
  const y = y0 + dy * t;
  // A player's y is their feet.
  if (y < cy - 0.05 || y > cy + height) return null;
  return t;
}

/**
 * @param players  the live roster, as a Map of id -> player
 * @param broadcast  send a message to everyone
 * @param damage  (shooter, victim, amount) -> void; the server's own damage path, so
 *                armour, the amplifier, kills, flags and respawns all behave identically
 *                whether the hit came from a bullet or a blast.
 */
function createProjectiles({ players, broadcast, damage }) {
  const live = new Map();
  let nextId = 1;

  function spawn(shooter, origin, dir, now) {
    const w = weapon(shooter.weapon);
    if (!w.projectile) return null;
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (!(len > 0)) return null;

    const p = {
      id: `p${nextId++}`,
      owner: shooter.id,
      team: shooter.team,
      kind: w.projectile.type,
      weaponId: shooter.weapon,
      x: origin.x,
      y: origin.y,
      z: origin.z,
      dx: dir.x / len,
      dy: dir.y / len,
      dz: dir.z / len,
      speed: w.projectile.speed,
      damage: w.damage,
      splash: w.projectile.splashRadius,
      wallHits: 0,
      maxWallHits: w.projectile.bounces,
      at: now,
      diesAt: now + Math.min(w.projectile.lifeMs, MAX_LIFE_MS),
    };
    live.set(p.id, p);
    broadcast({
      type: "projectile",
      id: p.id,
      owner: p.owner,
      kind: p.kind,
      x: r2(p.x), y: r2(p.y), z: r2(p.z),
      dx: r3(p.dx), dy: r3(p.dy), dz: r3(p.dz),
      speed: p.speed,
      t: now,
    });
    return p;
  }

  function tick(now) {
    for (const p of [...live.values()]) {
      if (now >= p.diesAt) {
        retire(p, "expired");
        continue;
      }
      const dt = Math.min(now - p.at, STEP_MS * 4) / 1000;
      p.at = now;
      if (dt <= 0) continue;

      let travel = p.speed * dt;
      // A bounce inside a single tick has to keep going with what is left of the step,
      // or a blade skimming a corner loses most of its distance to that tick.
      for (let leg = 0; leg < 8 && travel > 1e-4; leg++) {
        const dx = p.dx * travel;
        const dy = p.dy * travel;
        const dz = p.dz * travel;

        // Nearest player, then nearest wall; whichever comes first wins.
        let bestT = Infinity;
        let victim = null;
        for (const other of players.values()) {
          if (other.id === p.owner) continue; // your own rocket does not hit you at the muzzle
          if (other.hp <= 0) continue;
          const t = sweepCylinder(p.x, p.y, p.z, dx, dy, dz, other.x, other.y, other.z, PAWN.radius, PAWN.height);
          if (t !== null && t < bestT) {
            bestT = t;
            victim = other;
          }
        }
        const wall = raycast(p.x, p.y, p.z, p.dx, p.dy, p.dz, travel);
        const wallT = wall ? wall.t / travel : Infinity;

        if (victim && bestT <= wallT) {
          p.x += dx * bestT;
          p.y += dy * bestT;
          p.z += dz * bestT;
          hit(p, victim, now);
          break;
        }
        if (wall) {
          p.x = wall.x + wall.nx * 0.02;
          p.y = wall.y + wall.ny * 0.02;
          p.z = wall.z + wall.nz * 0.02;
          if (p.wallHits >= p.maxWallHits) {
            hit(p, null, now);
            break;
          }
          // Razor2's own reflection, and its own rule that the blade keeps its speed
          // rather than losing energy: "Velocity = Speed * X — impart ONLY forward vel".
          p.wallHits++;
          const dot = p.dx * wall.nx + p.dy * wall.ny + p.dz * wall.nz;
          p.dx -= 2 * dot * wall.nx;
          p.dy -= 2 * dot * wall.ny;
          p.dz -= 2 * dot * wall.nz;
          const n = Math.hypot(p.dx, p.dy, p.dz) || 1;
          p.dx /= n; p.dy /= n; p.dz /= n;
          broadcast({
            type: "projectile-bounce",
            id: p.id,
            x: r2(p.x), y: r2(p.y), z: r2(p.z),
            dx: r3(p.dx), dy: r3(p.dy), dz: r3(p.dz),
            t: now,
          });
          travel -= wall.t;
          continue;
        }
        p.x += dx;
        p.y += dy;
        p.z += dz;
        break;
      }
    }
  }

  /** A direct hit, a wall, or the end of a life. Everything ends up here. */
  function hit(p, victim, now) {
    if (victim) {
      const shooter = players.get(p.owner);
      if (shooter) damage(shooter, victim, p.damage);
    }
    if (p.splash > 0) hurtRadius(p, now);
    retire(p, "hit");
  }

  /**
   * UT99's HurtRadius, falloff and all. Everyone in range takes damage scaled by how far
   * the edge of their collision cylinder is from the blast — the shooter included, which
   * is what makes firing a rocket at your own feet a decision rather than a free move.
   */
  function hurtRadius(p, now) {
    const shooter = players.get(p.owner);
    if (!shooter) return;
    for (const victim of players.values()) {
      if (victim.hp <= 0) continue;
      // Measure to the middle of the body, not to its feet.
      const dist = Math.hypot(victim.x - p.x, victim.y + PAWN.height / 2 - p.y, victim.z - p.z);
      const scale = 1 - Math.max(0, (dist - PAWN.radius) / p.splash);
      if (scale <= 0) continue;
      const amount = Math.round(p.damage * scale);
      if (amount <= 0) continue;
      damage(shooter, victim, amount);
    }
  }

  function retire(p, why) {
    if (!live.has(p.id)) return;
    live.delete(p.id);
    broadcast({
      type: "projectile-gone",
      id: p.id,
      kind: p.kind,
      why,
      x: r2(p.x), y: r2(p.y), z: r2(p.z),
      splash: p.splash,
    });
  }

  /** Every projectile in the air, for a joining client to catch up on. */
  function snapshot(now) {
    return [...live.values()].map((p) => ({
      id: p.id, owner: p.owner, kind: p.kind,
      x: r2(p.x), y: r2(p.y), z: r2(p.z),
      dx: r3(p.dx), dy: r3(p.dy), dz: r3(p.dz),
      speed: p.speed, t: now,
    }));
  }

  function clear() {
    for (const p of [...live.values()]) retire(p, "reset");
  }

  return { spawn, tick, clear, snapshot, count: () => live.size, STEP_MS };
}

const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

module.exports = { createProjectiles, sweepCylinder, STEP_MS };
