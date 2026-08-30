#!/usr/bin/env node
// gen-map-actors.mjs — turn Epic's CTF-Face actor table into the world-anchored
// coordinates this game runs on.
//
//   node scripts/gen-map-actors.mjs          # rewrite the generated modules
//   node scripts/gen-map-actors.mjs --check  # fail if they are out of date (CI/pre-commit)
//
// INPUT  scripts/data/ctf-face-actors.json — flag bases, player starts and pickups, in
//        Unreal Units, as placed in the original level. Coordinates and class names
//        only: no Epic art, geometry, sound or text is in this repo, and none should
//        ever be. A position is a fact about a level layout, not an asset.
// OUTPUT src/shared/map-actors.js   (ES module — browser game + the ctf test)
//        server/map-actors.js       (CommonJS twin — server/ has no "type": "module",
//                                    so it cannot import the one above, and it lives
//                                    inside server/ so it deploys with server.js
//                                    whatever root directory the host is pointed at)
//
// Both outputs are written from this one run, so they cannot drift from each other.
// Do not hand-edit either of them.
//
// ---------------------------------------------------------------------------
// WHAT IS DERIVED HERE AND WHAT IS MEASURED
// ---------------------------------------------------------------------------
// Everything horizontal (x, z) and every heading comes from the actor table through
// uuToScene()/utYawToSceneRad() in src/shared/map-transform.js. Nothing is eyeballed.
//
// The SHIPPED NAVMESH is the one place the actor table is NOT the best source. The fit's
// residual is ~0.25 scene units on PlayerStarts but over a unit on pickups inside the
// tower alcoves, because the fan model simplified those interiors — and the fan model
// also has small holes where the original level has solid floor. Trusting the raw fit
// there puts a flag stand a metre in the air and a PlayerStart over a hole.
//
// So every actor that has to stand on something is put through snapToSurface()
// (scripts/lib/navmesh.mjs): it reads assets/3d/navmesh.gltf, takes y from the polygon
// under the actor ON ITS OWN STOREY, and — if there is no such polygon — walks the x/z
// to the nearest spot that has one with mesh all around it. This is the build-time twin
// of the downward raycast src/game/core/spawn.js does at runtime, run once over the
// whole set instead of one point at a time by whoever happens to spawn there.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORLD_SCALE, uuToScene, utYawToSceneRad } from "../src/shared/map-transform.js";
import { loadNavmesh, snapToSurface } from "./lib/navmesh.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const INPUT = path.join(ROOT, "scripts", "data", "ctf-face-actors.json");
const OUT_ESM = path.join(ROOT, "src", "shared", "map-actors.js");
const OUT_CJS = path.join(ROOT, "server", "map-actors.js");
const NAVMESH = path.join(ROOT, "assets", "3d", "navmesh.gltf");

// ---------------------------------------------------------------------------
// MEASURED: the shipped geometry, not the Unreal actor table.
//
// Read off assets/3d/navmesh.gltf and assets/3d/map/FacingWorlds_tex_5.gltf and then
// multiplied by WORLD_SCALE, exactly as scripts/optimize-assets.mjs does to the files
// the game loads. Source values (pre-scale, in the .gltf's own units):
//
//   navmesh bbox      y -0.175 .. 30.425
//   blue tower bbox   x -40.546 .. -24.252,  z -8.651 .. 8.521
//   red tower bbox    x  33.849 ..  50.142,  z -13.459 .. 3.705
//
// The navmesh's lowest polygon is the pedestal ground both bases stand on; its highest
// is the tower roof deck. The tower bboxes are the mesh columns, so their x/z centres
// are the roof centres and their half-extents are a generous — but not absurd — "is
// this pose above a tower?" box for the anti-cheat. Cross-check: converting the two
// roof-top Body Armor actors through uuToScene() lands them at y 71.19 and 71.77
// against a measured deck of 71.06, which is the ~0.7 UT pickup hover. The two
// independent sources agree.
// ---------------------------------------------------------------------------
const MEASURED = {
  navmeshMinY: -0.175,
  navmeshMaxY: 30.425,
  towers: {
    blue: { minX: -40.546, maxX: -24.252, minZ: -8.651, maxZ: 8.521 },
    red: { minX: 33.849, maxX: 50.142, minZ: -13.459, maxZ: 3.705 },
  },
};

// How far above the surface a UT pickup floats. PLAYER-anchored, so it is NOT scaled by
// WORLD_SCALE: this is "roughly knee height on the person running into it", and the
// player did not change size when the map did. (A plain x k here would have floated the
// items at 1.92 — over the head of a 1.83 m soldier.)
const PICKUP_HOVER = 1.0;

const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------------------

const src = JSON.parse(fs.readFileSync(INPUT, "utf8"));

const GROUND_Y = r2(MEASURED.navmeshMinY * WORLD_SCALE);
const ROOF_Y = r2(MEASURED.navmeshMaxY * WORLD_SCALE);

const roof = (t) => {
  const b = MEASURED.towers[t];
  return {
    x: r2(((b.minX + b.maxX) / 2) * WORLD_SCALE),
    y: ROOF_Y,
    z: r2(((b.minZ + b.maxZ) / 2) * WORLD_SCALE),
  };
};
const halfExtent = (axis) =>
  r2(
    (Math.max(
      MEASURED.towers.blue[`max${axis}`] - MEASURED.towers.blue[`min${axis}`],
      MEASURED.towers.red[`max${axis}`] - MEASURED.towers.red[`min${axis}`]
    ) /
      2) *
      WORLD_SCALE
  );

const TOWER_ROOFS = {
  red: roof("red"),
  blue: roof("blue"),
  HALF_EXTENT: { x: halfExtent("X"), z: halfExtent("Z") },
};

// UT's Team/TeamNumber: 0 is red, 1 is blue. FlagBase0 is the red base, FlagBase1 blue.
const teamOf = (n) => (n === 0 ? "red" : "blue");

// The shipped navmesh, at the scale the game loads it at. Every standing position below
// is put through it; nothing here trusts the fit's raw x/z or y on its own.
const NAV = loadNavmesh(NAVMESH, WORLD_SCALE);
const nudges = [];
const stand = (label, p) => {
  const s = snapToSurface(NAV, p.x, p.z, p.y);
  if (s.nudge > 0.005) nudges.push({ label, dist: s.nudge, from: p, to: s });
  return s;
};

// z-fighting lift in renderer units (see src/game/core/spawn.js), not a world distance,
// so it is deliberately NOT scaled by WORLD_SCALE. Anything that stands ON the navmesh —
// flag stands, player spawns — sits at surface + this.
const NAVMESH_LIFT = 0.05;

// Flag bases, at the FOOT of each tower. The roofs are sniper decks; the flags have never
// been up there.
//
// Both x/z AND y are navmesh-snapped, not taken from the fit. There is no plinth geometry
// under either base in the fan model, so the fit's ~0.35-unit vertical residual (the
// worst of any actor class) shows up as a flag stand hanging in mid-air. Worse, the blue
// base converts to a spot the fan navmesh does not cover at all — the only thing under it
// is a mid-tower ledge 23 units UP — so it needs the x/z walked back onto the floor too.
const FLAG_HOMES = {};
for (const a of src.flagBases) {
  const team = teamOf(a.Team);
  const p = uuToScene(a.location.x, a.location.y, a.location.z);
  const s = stand(`FLAG_HOMES.${team} (${a.name})`, p);
  FLAG_HOMES[team] = {
    x: r2(s.x),
    y: r2(s.y + NAVMESH_LIFT),
    z: r2(s.z),
    ry: r3(utYawToSceneRad(a.yawDeg)),
    ut: a.name,
  };
}

// All twenty PlayerStarts, ten a side, each with the heading Epic gave it, each planted
// on the navmesh polygon it stands on plus the lift.
//
// Snapping the x/z matters as much as the y here: two of the blue starts convert into
// holes in the fan navmesh, and a rig that spawns off-mesh is a rig the navmesh
// constraint has to rescue rather than one that is simply standing on the floor.
const SPAWNS = { red: [], blue: [] };
for (const a of src.playerStarts) {
  const team = teamOf(a.TeamNumber);
  const p = uuToScene(a.location.x, a.location.y, a.location.z);
  const s = stand(`SPAWNS.${team} (${a.name})`, p);
  SPAWNS[team].push({
    x: r2(s.x),
    y: r2(s.y + NAVMESH_LIFT),
    z: r2(s.z),
    ry: r3(utYawToSceneRad(a.yawDeg)),
    ut: a.name,
  });
}
for (const team of ["red", "blue"]) SPAWNS[team].sort((a, b) => a.x - b.x || a.z - b.z);

// Every pickup in the level, grouped by Unreal class, x/z converted and y left as the
// raw conversion. Nothing consumes the raw y directly — the two helpers below snap it —
// but it is the honest number and the place to start from for a spot not covered yet.
const UT_PICKUPS = {};
for (const a of src.pickups) {
  const p = uuToScene(a.location.x, a.location.y, a.location.z);
  (UT_PICKUPS[a.class] ||= []).push({ name: a.name, x: r2(p.x), y: r2(p.y), z: r2(p.z) });
}
for (const list of Object.values(UT_PICKUPS)) list.sort((a, b) => a.x - b.x || a.z - b.z);

/**
 * A pickup planted on the navmesh, hovering the UT amount above it.
 *
 * `surfaceY` says which storey the item belongs to (GROUND_Y or ROOF_Y) — it seeds the
 * search, it is not the answer: the height comes from the polygon actually under the
 * item, and if there is none (MedBox0 converts into a hole beside the red base) the x/z
 * moves to the nearest spot that has one.
 */
const onSurface = (a, surfaceY) => {
  const s = stand(`${a.name}`, { x: a.x, y: surfaceY, z: a.z });
  return { name: a.name, x: r2(s.x), y: r2(s.y + PICKUP_HOVER), z: r2(s.z) };
};

// The two Body Armor pedestals, one on each tower ROOF — the reward for making the
// climb, and the only reason to be up there besides the sniper deck itself.
const BODY_ARMOR = (UT_PICKUPS.armor2 || []).map((a) => onSurface(a, ROOF_Y));
// The eight MedBoxes, four in each tower base.
const MED_BOXES = (UT_PICKUPS.MedBox || []).map((a) => onSurface(a, GROUND_Y));
// The single big HealthPack, dead centre of the bridge — the most contested item on the
// map, and unused so far. Kept named because it is the obvious next thing to place. NOT
// surface-snapped: it stands on the bridge deck at y ~13, not on the base ground, and
// the bridge arches, so there is no single level to snap it to.
const HEALTH_PACK = UT_PICKUPS.HealthPack || [];

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

const j = (v) => JSON.stringify(v);
const list = (arr, indent = "  ") => arr.map((v) => `${indent}${j(v)},`).join("\n");

const counts = {
  flagBases: Object.keys(FLAG_HOMES).length,
  playerStarts: SPAWNS.red.length + SPAWNS.blue.length,
  pickups: Object.values(UT_PICKUPS).reduce((n, l) => n + l.length, 0),
  nudged: nudges.length,
  maxNudge: nudges.reduce((m, n) => Math.max(m, n.dist), 0).toFixed(1),
};

function body(exp) {
  return `// GENERATED by scripts/gen-map-actors.mjs — DO NOT EDIT.
//
// CTF-Face's real actor placements, converted from Unreal Units to this game's scene
// coordinates by src/shared/map-transform.js. Regenerate with:
//
//   node scripts/gen-map-actors.mjs
//
// Source: scripts/data/ctf-face-actors.json (${counts.flagBases} flag bases,
// ${counts.playerStarts} player starts, ${counts.pickups} pickups). Every x and z here starts
// as Epic's, put through the measured similarity transform.
//
// Then everything that stands on something is SNAPPED TO THE SHIPPED NAVMESH: y comes
// from the polygon under the actor, and where the fan model has a hole the original level
// does not, the x/z is walked to the nearest covered spot (${counts.nudged} of them needed it,
// by at most ${counts.maxNudge} units — the blue flag base, three PlayerStarts and one MedBox).
// The fit is good to ~0.25 units outdoors and worse than a unit inside the tower alcoves,
// which is the difference between a flag stand on the ground and one hanging in the air.
//
// \`ry\` is a three.js rotation.y in RADIANS, already through the handedness flip.
// \`ut\` names the original actor, so any number here can be traced back to the level.

// The pedestal ground both bases stand on: the navmesh's lowest polygon.
${exp} GROUND_Y = ${GROUND_Y};

// Where the flags actually live in CTF-Face: at the FOOT of each tower, not on the roof.
// The roofs are sniper decks. \`y\` is the navmesh surface plus the 0.05 lift, so the stand
// sits ON the ground rather than the ~0.5 above it the raw fit gives (there is no plinth
// modelled in the fan map). Facing (\`ry\`) is the base's own, which is what the flag stand
// should be turned to.
${exp} FLAG_HOMES = {
  red: ${j(FLAG_HOMES.red)},
  blue: ${j(FLAG_HOMES.blue)},
};

// The tower roof decks: centre, walkable height, and a half-extent box around each that
// covers the whole tower column. Used by the anti-cheat to answer "could a player
// legitimately be this high here?" — the only two places on the map where the answer
// above the bridge is yes.
${exp} TOWER_ROOFS = {
  red: ${j(TOWER_ROOFS.red)},
  blue: ${j(TOWER_ROOFS.blue)},
  HALF_EXTENT: ${j(TOWER_ROOFS.HALF_EXTENT)},
};

// All twenty PlayerStarts, ten a side, sorted along x. Handed out round-robin. Each one
// is on a navmesh polygon, at that polygon's height plus the 0.05 lift.
${exp} SPAWNS = {
  red: [
${list(SPAWNS.red)}
  ],
  blue: [
${list(SPAWNS.blue)}
  ],
};

// Body Armor in the original; this game has no armour, so the two roof pedestals carry
// the second Enforcer instead. Same bargain either way: climb the tower, get the prize.
${exp} BODY_ARMOR = [
${list(BODY_ARMOR)}
];

// The eight MedBoxes in the tower bases.
${exp} MED_BOXES = [
${list(MED_BOXES)}
];

// The big HealthPack at the centre of the bridge, on the bridge deck (raw converted y,
// not surface-snapped — the bridge arches). Not placed in-game yet.
${exp} HEALTH_PACK = [
${list(HEALTH_PACK)}
];

// Every pickup in the level, by Unreal class, y unsnapped. Reference material for
// whatever gets placed next — weapons, ammo, the UDamage on each ramp.
${exp} UT_PICKUPS = {
${Object.keys(UT_PICKUPS)
  .sort()
  .map((k) => `  ${JSON.stringify(k)}: [\n${list(UT_PICKUPS[k], "    ")}\n  ],`)
  .join("\n")}
};
`;
}

// ---------------------------------------------------------------------------
// verify: every emitted standing position is ON the navmesh, at the ROUNDED numbers
//
// Rounding to centimetres after snapping is a 5 mm move, which cannot walk a point off a
// polygon it was 0.5 clear of — but the whole reason this file exists is that positions
// derived from a fit and then trusted turn out to be wrong, so check rather than assume.
// ---------------------------------------------------------------------------
const offMesh = [];
const mustBeOnMesh = (label, p, expectY) => {
  const hits = NAV.heightsAt(p.x, p.z);
  const near = hits.filter((h) => Math.abs(h - expectY) <= 1.5);
  if (!near.length) offMesh.push(`${label} at (${p.x}, ${p.z}) has no navmesh at y~${r2(expectY)} (found [${hits.map(r2)}])`);
};
mustBeOnMesh("FLAG_HOMES.red", FLAG_HOMES.red, FLAG_HOMES.red.y - NAVMESH_LIFT);
mustBeOnMesh("FLAG_HOMES.blue", FLAG_HOMES.blue, FLAG_HOMES.blue.y - NAVMESH_LIFT);
for (const team of ["red", "blue"]) {
  for (const p of SPAWNS[team]) mustBeOnMesh(`SPAWNS.${team} ${p.ut}`, p, p.y - NAVMESH_LIFT);
}
for (const p of MED_BOXES) mustBeOnMesh(`MED_BOXES ${p.name}`, p, p.y - PICKUP_HOVER);
for (const p of BODY_ARMOR) mustBeOnMesh(`BODY_ARMOR ${p.name}`, p, p.y - PICKUP_HOVER);
if (offMesh.length) {
  console.error("\nOFF-MESH POSITIONS — refusing to write:\n  " + offMesh.join("\n  "));
  process.exit(1);
}

const esm = body("export const");
const cjs =
  body("const").replace(/^\/\/ GENERATED/, "// GENERATED") +
  `
module.exports = { GROUND_Y, FLAG_HOMES, TOWER_ROOFS, SPAWNS, BODY_ARMOR, MED_BOXES, HEALTH_PACK, UT_PICKUPS };
`;

const outputs = [
  [OUT_ESM, esm],
  [OUT_CJS, cjs],
];

const check = process.argv.includes("--check");
let stale = false;
for (const [file, text] of outputs) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (current === text) {
    console.log(`  up to date  ${path.relative(ROOT, file)}`);
    continue;
  }
  stale = true;
  if (check) {
    console.error(`  STALE       ${path.relative(ROOT, file)}`);
    continue;
  }
  fs.writeFileSync(file, text);
  console.log(`  wrote       ${path.relative(ROOT, file)}`);
}

if (check && stale) {
  console.error("\nRun `node scripts/gen-map-actors.mjs` and commit the result.");
  process.exit(1);
}

if (nudges.length) {
  console.log(`\n  ${nudges.length} position(s) walked onto the navmesh (the fan model has holes the level does not):`);
  for (const n of nudges.sort((a, b) => b.dist - a.dist)) {
    console.log(
      `    ${n.label.padEnd(34)} ${n.dist.toFixed(2)} away  ` +
        `(${r2(n.from.x)}, ${r2(n.from.z)}) -> (${r2(n.to.x)}, ${r2(n.to.z)})  surface y ${r2(n.to.y)}`
    );
  }
}

console.log(
  `\n${counts.flagBases} flag bases, ${counts.playerStarts} player starts, ${counts.pickups} pickups ` +
    `-> ground ${GROUND_Y}, roof ${ROOF_Y}, ` +
    `flags red ${j(FLAG_HOMES.red.x)}/${j(FLAG_HOMES.red.z)} blue ${j(FLAG_HOMES.blue.x)}/${j(FLAG_HOMES.blue.z)}`
);
