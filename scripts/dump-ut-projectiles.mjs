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
import { loadPackage, classDefaults, scriptText } from "./lib/upkg.mjs";

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

const out = { source: "UT99 retail BotPack.u", packageVersion: pkg.version, weapons: {} };
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
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${path.relative(ROOT, OUT)}`);
for (const [id, w] of Object.entries(out.weapons)) {
  console.log(
    `  ${id.padEnd(9)} speed ${String(w.speed).padStart(4)}  dmg ${String(w.damage).padStart(4)}` +
      `  splash ${String(w.splashRadius ?? "—").padStart(4)}  mesh ${w.mesh}  ${w.bounces ? "bounces" : ""}`,
  );
}
