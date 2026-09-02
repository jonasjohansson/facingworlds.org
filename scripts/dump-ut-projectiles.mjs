#!/usr/bin/env node
// dump-ut-projectiles.mjs — read UT99's own projectile numbers out of the retail package.
//
//   node scripts/dump-ut-projectiles.mjs [path-to-UT-System]
//
// DEV TOOLING. It needs a retail Unreal Tournament install, so it is not part of any
// build: it writes scripts/data/ut-projectiles.json, that file is committed, and
// gen-weapons.mjs reads the JSON. Exactly the arrangement scripts/data/ctf-face-*.json
// already uses for the map — the repo builds on a machine that has never seen the game.
//
// WHERE EACH NUMBER COMES FROM, because they live in two different places:
//
//   speed, damage, momentum, lifespan, mesh   class default properties
//   splash radius                             the HurtRadius() call in the class's own
//                                             UnrealScript, which UT99 ships as a
//                                             TextBuffer inside the package
//
// Nothing here is typed from memory. If a number cannot be found the run fails rather
// than falling back to a plausible one.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadPackage, classDefaults, scriptText, readProperties } from "./lib/upkg.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT = path.join(ROOT, "scripts", "data", "ut-projectiles.json");
const SYSTEM =
  process.argv[2] || path.join(os.homedir(), "Downloads", "Unreal Tournament", "System");

// The three projectile weapons on CTF-Face, each as (weapon class, projectile class).
const WEAPONS = [
  { id: "rocket", weapon: "UT_Eightball", projectile: "RocketMk2", pickup: "weapon-rocket" },
  { id: "ripper", weapon: "ripper", projectile: "Razor2", pickup: "weapon-ripper" },
  { id: "redeemer", weapon: "WarheadLauncher", projectile: "WarShell", pickup: "weapon-redeemer" },
];

const pkgPath = path.join(SYSTEM, "BotPack.u");
if (!fs.existsSync(pkgPath)) {
  console.error(`no BotPack.u at ${pkgPath}`);
  console.error("Pass the path to a retail UT99 System/ directory as the first argument.");
  process.exit(1);
}
const pkg = loadPackage(fs.readFileSync(pkgPath));

/**
 * The blast radius of a direct hit, out of the HurtRadius(damage, radius, ...) call in
 * the class's own UnrealScript.
 *
 * WHICH call matters. WarShell has two: Explode() uses 300 for hitting something, and
 * TakeDamage() uses 350 for being shot out of the air. Taking whichever appears first
 * gives the Redeemer a blast radius it only has when someone else destroys it.
 * RocketMk2 puts its HurtRadius in BlowUp(), which Explode() calls — so look for BlowUp
 * first, then Explode, and never anything else.
 */
function splashRadius(className) {
  const src = scriptText(pkg, pkg.findClass(className));
  if (!src) return null;
  for (const fn of ["BlowUp", "Explode"]) {
    const body = functionBody(src, fn);
    if (!body) continue;
    const m = /HurtRadius\s*\([^,]+,\s*([0-9.]+)/.exec(body);
    if (m) return Number(m[1]);
  }
  return null;
}

/** The text of one UnrealScript function, brace-matched from its declaration. */
function functionBody(src, name) {
  const decl = new RegExp(`function\\s+${name}\\s*\\(`, "i").exec(src);
  if (!decl) return null;
  const open = src.indexOf("{", decl.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

// What a projectile has to hit. TournamentPlayer is the class every UT99 player is, and
// its collision cylinder is what HurtRadius measures distances against — the radius shows
// up in the falloff as `dist - Victims.CollisionRadius`, so the same number has to be
// here or splash damage is wrong near the edge.
const pawn = classDefaults(pkg, pkg.findClass("TournamentPlayer"));
if (pawn.CollisionRadius === undefined || pawn.CollisionHeight === undefined) {
  throw new Error("TournamentPlayer has no collision cylinder");
}

const out = {
  source: "UT99 retail BotPack.u",
  packageVersion: pkg.version,
  // CollisionHeight is a HALF height in UE1: 39 makes a body 78 units tall.
  pawn: { collisionRadius: pawn.CollisionRadius, collisionHalfHeight: pawn.CollisionHeight },
  weapons: {},
};
for (const w of WEAPONS) {
  const wd = classDefaults(pkg, pkg.findClass(w.weapon));
  const pd = classDefaults(pkg, pkg.findClass(w.projectile));
  const need = (obj, key, where) => {
    if (obj[key] === undefined) throw new Error(`${w.id}: ${where} has no ${key}`);
    return obj[key];
  };
  out.weapons[w.id] = {
    pickup: w.pickup,
    weaponClass: w.weapon,
    projectileClass: w.projectile,
    refireRate: need(wd, "RefireRate", w.weapon),
    speed: need(pd, "speed", w.projectile),
    maxSpeed: pd.MaxSpeed ?? null,
    damage: need(pd, "Damage", w.projectile),
    momentumTransfer: need(pd, "MomentumTransfer", w.projectile),
    lifeSpan: pd.LifeSpan ?? null,
    splashRadius: splashRadius(w.projectile),
    mesh: pd.Mesh ?? null,
    drawScale: pd.DrawScale ?? 1,
    bounces: pd.bBounce === true,
    damageType: pd.MyDamageType ?? null,
  };
}
// The explosions, which are the reason none of this needs a shader. UT99 draws a rocket
// blast as a camera-facing quad playing a frame sequence — UT_SpriteBallExplosion is 8
// frames over 0.7 s, WarExplosion is 18 over 1 s — and the frames are ordinary 128px
// bitmaps sitting in the package. The procedural FireTexture effects (smoke trails, the
// flame licks) are a different thing entirely: a cellular automaton with a palette, a few
// hundred BYTES of parameters rather than an image, and deliberately not reproduced here.
//
// DrawScale is a sanity check as much as a size: a 128-pixel sprite at 1.4 is 179 UU
// across against the rocket's 220 UU blast radius, and at 2.8 it is 358 against the
// Redeemer's 300. The picture matches the damage.
const EXPLOSIONS = [
  { id: "rocket", cls: "UT_SpriteBallExplosion" },
  { id: "redeemer", cls: "WarExplosion" },
];
out.explosions = {};
for (const e of EXPLOSIONS) {
  const d = classDefaults(pkg, pkg.findClass(e.cls));
  const base = d.Texture;
  const frames = d.NumFrames;
  if (!base || !frames) throw new Error(`${e.cls}: no Texture/NumFrames to animate`);
  // exp1_a00 -> exp1_a%02d. The suffix is the frame number and the stem is the sequence.
  const m = /^(.*?)(\d+)$/.exec(base);
  if (!m) throw new Error(`${e.cls}: cannot read a frame number out of ${base}`);
  // Style 3 is STY_Translucent and DrawType 7 is DT_SpriteAnimOnce, both out of
  // Engine.Actor's own enums. Translucent is the one that matters: in UE1 a translucent
  // sprite's BRIGHTNESS is its opacity, so black is invisible and the sheet has to be
  // drawn additively rather than alpha-blended. WarExplosion's last frame is 100% opaque
  // near-black — alpha-blend it and the Redeemer ends with a black square on screen;
  // draw it the way UT99 says and it is the blast fading out.
  const STY_TRANSLUCENT = 3;
  const DT_SPRITE_ANIM_ONCE = 7;
  if (d.Style !== STY_TRANSLUCENT) {
    throw new Error(`${e.cls}: Style ${d.Style}, expected STY_TRANSLUCENT — check the blend mode`);
  }
  // The frame's own pixel size, read off the first texture. A UE1 sprite is drawn
  // USize * DrawScale units across, so this plus DrawScale is the blast's world size —
  // and it is a check on the damage numbers as much as a measurement: 128 * 1.4 is 179
  // units against the rocket's 220-unit blast radius, 128 * 2.8 is 358 against the
  // Redeemer's 300. The picture and the damage agree.
  const first = pkg.exports.find((x) => x.name === base && pkg.classOf(x) === "Texture");
  if (!first) throw new Error(`${e.cls}: no texture named ${base}`);
  const texProps = readProperties(pkg, { p: first.offset }, first.offset + first.size);
  if (!texProps.USize) throw new Error(`${base}: no USize`);

  out.explosions[e.id] = {
    class: e.cls,
    frameSize: texProps.USize,
    stem: m[1],
    firstFrame: Number(m[2]),
    frames,
    lifeSeconds: d.LifeSpan ?? 1,
    drawScale: d.DrawScale ?? 1,
    blend: "additive",
    once: d.DrawType === DT_SPRITE_ANIM_ONCE,
  };
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${path.relative(ROOT, OUT)}`);
for (const [id, e] of Object.entries(out.explosions)) {
  console.log(`  ${id.padEnd(9)} explosion ${e.stem}${String(e.firstFrame).padStart(2, "0")}.. x${e.frames} over ${e.lifeSeconds}s at scale ${e.drawScale}`);
}
for (const [id, w] of Object.entries(out.weapons)) {
  console.log(
    `  ${id.padEnd(9)} speed ${String(w.speed).padStart(4)}  dmg ${String(w.damage).padStart(4)}` +
      `  splash ${String(w.splashRadius ?? "—").padStart(4)}  mesh ${w.mesh}  ${w.bounces ? "bounces" : ""}`,
  );
}
