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
// The noise a weapon makes as it is raised. TournamentWeapon.PlaySelect plays it in the
// same function as PlayAnim('Select'), so it belongs beside the fire sound rather than
// inside `view` — the sound is not a rendering detail, it is the other half of an event.
const selectSound = (id) => SOUND_DATA.select?.[id]?.file ?? null;

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
    selectSound: selectSound("enforcer"),
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
    selectSound: selectSound("sniper"),
  },
  shock: {
    name: "Shock Rifle",
    damage: 40,
    fireRate: 1 / 0.6,
    model: "assets/3d/pickups/ShockRifle/ShockRifle.gltf",
    pickup: "weapon-shock",
    sound: fireSound("shock"),
    selectSound: selectSound("shock"),
  },
  rocket: {
    name: "Rocket Launcher",
    damage: PROJECTILE_DATA.weapons.rocket.damage,
    fireRate: 1 / 1.1,
    model: "assets/3d/pickups/UT_Eightball/UT_Eightball.gltf",
    pickup: "weapon-rocket",
    sound: fireSound("rocket"),
    selectSound: selectSound("rocket"),
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
    selectSound: selectSound("ripper"),
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
    selectSound: selectSound("redeemer"),
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
// the arm as part of it, its own scale and RotOrigin, and its own baked vertex animation.
//
// scripts/build-ut-viewmodels.mjs extracts all of that; this only attaches it, and
// attaches EXACTLY the fields the client codes against — a pass-through of the whole
// manifest would put the extractor's working notes (which mesh, which frame, how many
// morph targets) into a table both processes load.
//
// `rotationDeg` is [0, 0, 0] for every weapon and stays in the table on purpose. The
// orientation is baked into the geometry now; the field is kept so that anything still
// reading it gets a harmless identity rather than an undefined it silently applies as NaN.
//
// `offsetUU` stays in RAW Unreal Units, also on purpose: UE1 draws the view weapon
// through its own projection, so the numbers are trustworthy relative to each other and
// not directly convertible to metres. The client maps them through one fitted constant.
const VIEWMODELS = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts", "data", "ut-viewmodels.json"), "utf8"),
).weapons;
for (const [id, w] of Object.entries(WEAPONS)) {
  const v = VIEWMODELS[id];
  if (!v) throw new Error(`${id}: no view model in ut-viewmodels.json — rerun build-ut-viewmodels.mjs`);
  // Two files, two generators, one fact: the select sound is named in the view manifest
  // (off the weapon class) and extracted by build-ut-sounds.mjs. If they ever disagree,
  // one of the two was regenerated against a different install.
  const named = SOUND_DATA.select?.[id]?.sound;
  if (v.selectSoundName && named && v.selectSoundName !== named) {
    throw new Error(
      `${id}: ut-viewmodels says SelectSound is ${v.selectSoundName}, ut-sounds says ${named}`,
    );
  }
  w.view = {
    model: v.model,
    // The Enforcer alone has two meshes: UT99 mirrors AutoML/AutoMR for the left and
    // right hand, and a dual pair uses both at once. Undefined for the other five.
    dualModel: v.dualModel,
    // Which hand UT99 draws it in. The Enforcer is drawn LEFT (enforcer.RenderOverlays
    // forces Handedness = 1 for a single one); the other five are authored left-handed
    // and mirrored by the engine for a right-handed player, so they read "right" here and
    // the client decides whether to mirror.
    hand: v.hand,
    rotationDeg: v.rotationDeg,
    // The barrel tip in the model's own metres, for the #weapon-muzzle child. Every
    // weapon used to borrow the Enforcer's, because the entity built for a picked-up
    // weapon had no muzzle child at all.
    muzzleLocal: v.muzzleLocal,
    sizeM: v.sizeM,
    bboxM: v.bboxM,
    offsetUU: v.playerViewOffsetUU,
    fireOffsetUU: v.fireOffsetUU,
    // The clips, by the name they carry in the glTF. `rate` is UnrealScript's multiplier
    // on the clip's own authored fps (which is already baked into the keyframe times), so
    // playing a clip at UT99's speed means setting the action's timeScale to `rate`.
    // `fire` is a LIST because the Sniper Rifle picks one of five at random per shot;
    // `fireRepeat` (Enforcer only) is PlayRepeatFiring's clip for the shots after the
    // first while the trigger stays down; `fireLoops` says whether the fire clip runs
    // once per shot or loops for as long as the trigger is held. Fire clips are never cut
    // short by the next shot — UT99 refires only after FinishAnim — and the client holds
    // the same rule, so cadence can be no faster than the animation.
    anims: v.anims,
    // ShakeView(time, mag, vert), fired on every shot by TournamentWeapon.ClientFire.
    shake: v.shake,
    // ClientInstantFlash — a full-screen tint, with the fog already through PlayerPawn's
    // 0.001. Null for the Sniper Rifle, which is the one weapon with no InstFlash. Rebuilt
    // rather than passed through so the manifest's provenance note (`from`, on the Rocket
    // Launcher, whose flash lives in code rather than in defaults) stays out of the table.
    instFlash: v.instFlash ? { scale: v.instFlash.scale, fog: v.instFlash.fog } : null,
    // A 2D canvas icon, not geometry: flashS * muzzleScale * ClipX/640 pixels across for
    // flashLength seconds, drawn translucent so black is transparent — blend additively.
    // Null for four of the six: only the Enforcer and the Sniper Rifle have an MFTexture.
    muzzleFlash: v.muzzleFlash,
  };
}

// ---------------------------------------------------------------------------
// THE THIRD-PERSON MODEL
// ---------------------------------------------------------------------------
// The gun in somebody ELSE's hands. UT99 ships a second mesh per weapon for exactly this
// — Engine.Inventory declares ThirdPersonMesh/ThirdPersonScale beside PlayerViewMesh and
// replicates them — because a view mesh is a 12 cm prop framed for a camera 8 cm away and
// a remote avatar needs a world-scale gun with a whole arm on it.
//
// scripts/build-ut-thirdperson.mjs extracts them through the CHARACTER pipeline's
// transform, so a body and its weapon land in one frame with forward on -Z, and lifts them
// onto the nominal 39 UU pawn so the model's own origin is the floor, exactly like a body.
// This only attaches, and attaches exactly what the client codes against.
//
// `anims` is NULL on four of the six, and that is Epic's rather than an omission: only
// AutoHand and ASMD2hand have more than one frame. `muzzleLocal` is the barrel tip in the
// model's own metres, derived the same way the view models' is.
//
// WHAT IS NOT HERE is where on a body the gun goes. That belongs to the BODY, not the
// weapon — a weapon has no wearer — so it lives in the character roster as
// MODELS[m].weaponOffsetM / weaponOffset(index), from Epic's own weapon-attachment
// vertices. The geometry here is lifted onto the nominal pawn, which leaves it at the
// pawn's ACTOR ORIGIN: 42 cm below and 43 cm behind the Soldier's fist, down at the hip.
// A client parents a weapon to an avatar and adds that one vector.
const THIRDPERSON = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts", "data", "ut-thirdperson.json"), "utf8"),
).weapons;
for (const [id, w] of Object.entries(WEAPONS)) {
  const t = THIRDPERSON[id];
  if (!t) {
    throw new Error(`${id}: no third-person model in ut-thirdperson.json — rerun build-ut-thirdperson.mjs`);
  }
  w.third = {
    model: t.model,
    sizeM: t.sizeM,
    bboxM: t.bboxM,
    // The clips UT99 plays on this mesh, by the name they carry in the glTF, with
    // UnrealScript's rate MULTIPLIER on each — the same multiplier as the view model's,
    // because a weapon actor has ONE AnimSequence and UE1 plays it on whichever of the two
    // meshes it is currently drawing. Null where the mesh is a single frame.
    anims: t.anims,
    muzzleLocal: t.muzzleLocal,
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
