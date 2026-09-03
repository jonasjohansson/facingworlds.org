#!/usr/bin/env node
// gen-weapons.mjs — write the weapon table for both processes from one source.
//
//   node scripts/gen-weapons.mjs          # rewrite src/shared/weapons.js + server/weapons.js
//   node scripts/gen-weapons.mjs --check  # fail if out of date
//
// The server owns damage and cadence (a client never gets to pick either) and the
// client owns what the weapon looks like in your hands. Both have to agree on the id,
// so one table generates both — the same arrangement as the character roster.
//
// WHAT IS DERIVED AND WHAT IS CHOSEN. Worth being exact, because an earlier version of
// this header claimed all of it came from Botpack's class defaults and only the damage
// did.
//
// DERIVED, read out of the retail package by scripts/lib/upkg.mjs:
//   Enforcer      17   Botpack.enforcer  hitdamage
//   Shock Rifle   40   Botpack.ShockRifle  hitdamage
//   Sniper Rifle  45   in SniperRifle's own source: TakeDamage(45, ...). The same
//                      function does 100 for a headshot, which this game does not
//                      implement yet.
//   the three projectile weapons — speed, damage, splash radius, lifespan and mesh, out
//   of scripts/data/ut-projectiles.json. See scripts/dump-ut-projectiles.mjs.
//
// CHOSEN: every fireRate. UT99 does not store a shot interval — cadence falls out of the
// firing animation's length and its AnimRate, and RefireRate is a multiplier on that
// rather than a period. These are set to match the feel and are not claimed to be Epic's.
//
// The held model is the PICKUP mesh, the same way the Enforcer already works: what you
// see on the pedestal is literally what you pick up, and it costs no extra art.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UU_TO_M } from "../src/shared/map-transform.js";
import { gridFor } from "./lib/atlas.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT_SHARED = path.join(ROOT, "src", "shared", "weapons.js");
const OUT_SERVER = path.join(ROOT, "server", "weapons.js");
const CHECK = process.argv.includes("--check");

// UT99 speaks in Unreal Units; this game's scene is metres at pawn scale.
const uu = (n) => Math.round(n * UU_TO_M * 1000) / 1000;

const PROJECTILE_DATA = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts", "data", "ut-projectiles.json"), "utf8"),
);
// UT99's own weapon sounds — see scripts/build-ut-sounds.mjs, which reads each name off
// the class that plays it rather than listing them. Until this the game had ONE weapon
// sound for all six.
const SOUND_DATA = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts", "data", "ut-sounds.json"), "utf8"),
);
const fireSound = (id) => SOUND_DATA.fire[id]?.file ?? null;

// A projectile weapon's own numbers, converted once here so neither process converts.
// `bounces` is the wall-hit budget: Razor2's HitWall destroys the blade at NumWallHits
// greater than 6, and a rocket has no HitWall of its own so it inherits Projectile's,
// which explodes.
function projectile(id, { type, bounces }) {
  const d = PROJECTILE_DATA.weapons[id];
  if (!d) throw new Error(`${id} is not in ut-projectiles.json`);
  return {
    type,
    speed: uu(d.speed),
    splashRadius: d.splashRadius ? uu(d.splashRadius) : 0,
    lifeMs: Math.round((d.lifeSpan ?? 6) * 1000),
    bounces,
    model: `assets/3d/projectiles/${type}/${type}.gltf`,
  };
}

const WEAPONS = {
  enforcer: {
    name: "Enforcer",
    damage: 17,
    fireRate: 4, // shots per second
    model: null, // the markup weapon in index.html; every player spawns holding it
    pickup: null, // CTF-Face has no Enforcer pickup, as in the original
    sound: fireSound("enforcer"),
  },
  sniper: {
    name: "Sniper Rifle",
    damage: 45,
    fireRate: 1 / 1.5,
    model: "assets/3d/pickups/SniperRifle/SniperRifle.gltf",
    pickup: "weapon-sniper",
    // SniperRifle's own source: TakeDamage(100, ...) with AltDamageType "Decapitated",
    // against TakeDamage(45, ...) for a body hit. A flat number, not a multiplier.
    headshotDamage: 100,
    sound: fireSound("sniper"),
  },
  shock: {
    name: "Shock Rifle",
    damage: 40,
    fireRate: 1 / 0.6,
    model: "assets/3d/pickups/ShockRifle/ShockRifle.gltf",
    pickup: "weapon-shock",
    sound: fireSound("shock"),
  },
  rocket: {
    name: "Rocket Launcher",
    damage: PROJECTILE_DATA.weapons.rocket.damage,
    fireRate: 1 / 1.1,
    model: "assets/3d/pickups/UT_Eightball/UT_Eightball.gltf",
    pickup: "weapon-rocket",
    sound: fireSound("rocket"),
    projectile: projectile("rocket", { type: "rocket", bounces: 0 }),
    explosion: explosion("rocket"),
  },
  ripper: {
    name: "Ripper",
    damage: PROJECTILE_DATA.weapons.ripper.damage,
    fireRate: 1 / 0.6,
    model: "assets/3d/pickups/ripper/ripper.gltf",
    pickup: "weapon-ripper",
    sound: fireSound("ripper"),
    // Razor2: TakeDamage(3.5 * damage, ...) with damage type 'decapitated'. A multiplier
    // rather than a number, so it is computed from the damage above rather than restated.
    headshotDamage: Math.round(3.5 * PROJECTILE_DATA.weapons.ripper.damage),
    projectile: projectile("ripper", { type: "ripper", bounces: 6 }),
  },
  redeemer: {
    name: "Redeemer",
    damage: PROJECTILE_DATA.weapons.redeemer.damage,
    fireRate: 1 / 2.5,
    model: "assets/3d/pickups/WarheadLauncher/WarheadLauncher.gltf",
    pickup: "weapon-redeemer",
    sound: fireSound("redeemer"),
    projectile: projectile("redeemer", { type: "redeemer", bounces: 0 }),
    explosion: explosion("redeemer"),
  },
};

// ---------------------------------------------------------------------------
// THE FIRST-PERSON VIEW MODEL
// ---------------------------------------------------------------------------
// Until now a picked-up weapon was drawn with its PICKUP mesh at one hardcoded scale and
// one hardcoded rotation, both fitted to the Enforcer — so it had no arm and every weapon
// was wrong in its own direction. UT99 ships a separate PlayerViewMesh per weapon with
// the arm as part of it, plus that weapon's own scale and RotOrigin.
//
// scripts/build-ut-viewmodels.mjs extracts those; this only attaches them. `view.offset`
// stays in RAW Unreal Units on purpose: UE1 draws the view weapon through its own
// projection, so the numbers are trustworthy relative to each other and not directly
// convertible to metres. first-person-weapon.js maps them through one fitted constant.
const VIEWMODELS = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts", "data", "ut-viewmodels.json"), "utf8"),
).weapons;
for (const [id, w] of Object.entries(WEAPONS)) {
  const v = VIEWMODELS[id];
  if (!v) throw new Error(`${id}: no view model in ut-viewmodels.json — rerun build-ut-viewmodels.mjs`);
  w.view = {
    model: v.model,
    // Epic's own mesh rotation, in degrees. The Rocket Launcher's is -90 where every
    // other rifle's is +90, and the Redeemer turns on all three axes; a single constant
    // could express neither.
    rotationDeg: v.rotOriginDeg,
    // The barrel tip in the mesh's own unrotated units, for the #weapon-muzzle child.
    // Every weapon used to borrow the Enforcer's, because the entity built for a
    // picked-up weapon had no muzzle child at all.
    muzzleLocal: v.muzzleLocal,
    offsetUU: v.playerViewOffsetUU,
    fireOffsetUU: v.fireOffsetUU,
    sizeM: v.sizeM,
    bboxM: v.bboxM,
  };
}

// The body a projectile has to hit, and the radius HurtRadius measures its falloff
// against. UT99's CollisionHeight is a HALF height, so 39 is a body 1.83 m tall.
const PAWN = {
  radius: uu(PROJECTILE_DATA.pawn.collisionRadius),
  height: uu(PROJECTILE_DATA.pawn.collisionHalfHeight * 2),
  // A HEADSHOT, in UT99's own words. Both the Sniper Rifle and the Ripper spell out the
  // same test, character for character:
  //
  //     HitLocation.Z - Other.Location.Z > 0.62 * Other.CollisionHeight
  //
  // A UE1 actor's Location is the CENTRE of its collision cylinder, so this is 0.62 of a
  // half-height above the middle of the body — not above its feet. Here a player's y is
  // their feet, so the test is `hitY - (y + height/2) > headshotAboveCentre`.
  headshotAboveCentre: uu(0.62 * PROJECTILE_DATA.pawn.collisionHalfHeight),
};

// The blast a projectile leaves. UT99 draws it as a camera-facing quad playing a frame
// sequence — no shader then, none now — and every number here is Epic's: the frame count,
// how long it runs, and how big it is on screen (USize * DrawScale units across).
//
// "additive" is not a choice either. Both classes are Style STY_TRANSLUCENT, and in UE1 a
// translucent sprite's brightness IS its opacity, so black is invisible. Alpha-blend the
// sheet instead and the Redeemer ends on a black square, because its last frame is a
// fully opaque near-black one.
function explosion(id) {
  const e = PROJECTILE_DATA.explosions[id];
  if (!e) return null;
  const { cols, rows } = gridFor(e.frames);
  return {
    atlas: `assets/3d/projectiles/fx/${id}-explosion.png`,
    frames: e.frames,
    cols,
    rows,
    lifeMs: Math.round(e.lifeSeconds * 1000),
    size: uu(e.frameSize * e.drawScale),
    blend: e.blend,
    sound: SOUND_DATA.explode[id]?.file ?? null,
  };
}

const DEFAULT = "enforcer";
// pickup type -> weapon id, for the server's claim handler and the client's HUD.
const BY_PICKUP = Object.fromEntries(
  Object.entries(WEAPONS)
    .filter(([, w]) => w.pickup)
    .map(([id, w]) => [w.pickup, id])
);

const header = `// GENERATED by scripts/gen-weapons.mjs — DO NOT EDIT.
//
// CTF-Face's weapons, as far as they are implemented. Damage and cadence are UT99's
// own numbers; the held model is the pickup mesh, the way the Enforcer already works.
//
// Six weapons: three hitscan, three that fly. A projectile weapon carries a "projectile"
// block the server uses to simulate it — speed in metres per second, splash radius in
// metres, and a wall-hit budget. Those are UT99's own figures converted once; the
// fireRate beside them is not: UT99 has no shot interval to read, so cadence is chosen.
`;

const shared = `${header}
const WEAPONS = ${JSON.stringify(WEAPONS, null, 2)};

const DEFAULT_WEAPON = ${JSON.stringify(DEFAULT)};
const WEAPON_BY_PICKUP = ${JSON.stringify(BY_PICKUP, null, 2)};
const PAWN = ${JSON.stringify(PAWN)};
const PICKUP_SOUND = ${JSON.stringify(SOUND_DATA.pickup.file)};

/** The weapon for an id, falling back to the one everyone spawns with. */
function weapon(id) {
  return WEAPONS[id] || WEAPONS[DEFAULT_WEAPON];
}

export { WEAPONS, DEFAULT_WEAPON, WEAPON_BY_PICKUP, PAWN, PICKUP_SOUND, weapon };
`;

const server = `${header}
const WEAPONS = ${JSON.stringify(
  Object.fromEntries(
    Object.entries(WEAPONS).map(([id, w]) => [
      id,
      // The server needs the projectile block: it is the one that flies them.
      {
        name: w.name,
        damage: w.damage,
        fireRate: w.fireRate,
        ...(w.headshotDamage ? { headshotDamage: w.headshotDamage } : {}),
        ...(w.projectile ? { projectile: w.projectile } : {}),
      },
    ])
  ),
  null,
  2
)};

const DEFAULT_WEAPON = ${JSON.stringify(DEFAULT)};
const WEAPON_BY_PICKUP = ${JSON.stringify(BY_PICKUP, null, 2)};
const PAWN = ${JSON.stringify(PAWN)};
const PICKUP_SOUND = ${JSON.stringify(SOUND_DATA.pickup.file)};

/** The weapon for an id, falling back to the one everyone spawns with. */
function weapon(id) {
  return WEAPONS[id] || WEAPONS[DEFAULT_WEAPON];
}

module.exports = { WEAPONS, DEFAULT_WEAPON, WEAPON_BY_PICKUP, PAWN, PICKUP_SOUND, weapon };
`;

if (CHECK) {
  const stale = [[OUT_SHARED, shared], [OUT_SERVER, server]].filter(([f, want]) => {
    const cur = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    return cur !== want;
  });
  if (stale.length) {
    console.error(`${stale.map(([f]) => path.relative(ROOT, f)).join(", ")} out of date — run: node scripts/gen-weapons.mjs`);
    process.exit(1);
  }
  console.log("weapon table is up to date.");
  process.exit(0);
}
fs.writeFileSync(OUT_SHARED, shared);
fs.writeFileSync(OUT_SERVER, server);
console.log(
  `wrote the weapon table — ${Object.keys(WEAPONS).length} weapons\n` +
    Object.entries(WEAPONS).map(([id, w]) => `  ${id.padEnd(9)} ${String(w.damage).padStart(2)} dmg  ${w.fireRate.toFixed(2)}/s  ${w.pickup || "(spawn)"}`).join("\n")
);
