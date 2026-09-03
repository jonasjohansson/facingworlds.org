#!/usr/bin/env node
// build-ut-bsp.mjs — lift CTF-Face's collision geometry out of Epic's own level file.
//
//   node scripts/build-ut-bsp.mjs                     # uses ~/Downloads/Unreal Tournament
//   node scripts/build-ut-bsp.mjs /path/to/UT/Maps    # or point it at a Maps directory
//
// DEV TOOLING. It needs a retail Unreal Tournament install and is deliberately NOT in
// any npm script. The thing it writes — scripts/data/ctf-face-bsp.json — is committed
// so that whatever consumes it later runs on a clean checkout with no UT install, the
// same split gen-map-actors.mjs has with scripts/data/ctf-face-actors.json.
//
// Nothing consumes it yet. See the measurement below before wiring it to anything.
//
// OUTPUT scripts/data/ctf-face-bsp.json — points in raw Unreal Units, triangles as
//        index triples. UU, not scene units: the transform belongs to
//        src/shared/map-transform.js, and baking it here would freeze a fitted number
//        into a file that is supposed to hold facts about Epic's level.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS FOR, AND WHY NOTHING CONSUMES IT YET
// ---------------------------------------------------------------------------
// This is groundwork for replacing the fan model of CTF-Face with Epic's own level.
// It is NOT wired into gen-map-collision.mjs, and the measurement below is why.
//
// Epic's BSP is unambiguously the better description of the level. Dropping a ray
// straight down from each of Epic's 166 NavigationPoints:
//
//                       within 2 m of the node   more than 3 m below   worst case
//     Epic's BSP              151 / 166                 11               ~8 m
//     the fan model           129 / 166                 34               >10 m (15 of them)
//
// Epic's numbers cluster at a median of 1.24 m, which is what a NavigationPoint SHOULD
// read: a UT99 pawn's half-height is 39 UU = 0.92 m and the points float at about that.
// The fan model's median is 0.26 m with a p90 of 9.13 m — it agrees closely where it
// agrees and is a whole storey out where it does not, because it simplified the tower
// interiors. Of the nodes it puts on the wrong storey, 14 are InventorySpots; Epic's
// geometry puts every single InventorySpot on real floor. Epic's own eleven strays are
// 4 LiftExit, 2 Teleporter and 3 translocdest — which are supposed to hang over a shaft
// or an arc — plus 2 PathNodes.
//
// AND YET IT CANNOT BE ADOPTED ON ITS OWN, because collision has to agree with what the
// player SEES, and what the player sees is the fan model. Comparing this geometry
// against the rendered mesh at those same 166 points:
//
//     |difference| <= 0.5 m                        36 / 166
//     Epic BELOW the visible floor by > 0.5 m      95      (a rocket sinks into the ground)
//     Epic ABOVE the visible floor by > 0.5 m      35      (an invisible ledge)
//     p25 -1.19 m,  median -0.53 m,  p75 +0.18 m,  p95 +10.0 m
//
// That spread is the point: it is not a constant offset one number could absorb, it is
// genuine disagreement about where the floor is, nearly everywhere rather than just in
// the tower interiors. WORLD_SCALE and OFFSET were fitted to land Epic's ACTORS on the
// FAN model, so that fit has already absorbed the difference between the two — and
// pushing Epic's geometry through the same transform lands it consistently wrong.
//
// So the geometry is a package deal: render and collide from the same asset, or keep
// both from the other one. Moving the visuals across needs the textures out of a dozen
// .utx packages and the lightmaps UT99 bakes into the Model — without them the level
// renders flat and looks WORSE than the fan model, which is the opposite of the goal.
// Until that is done, gen-map-collision.mjs stays on the mesh the game draws.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackage, readProperties } from "./lib/upkg.mjs";
import { PF, findLevelModel, readModel, nodePolys, components } from "./lib/ubsp.mjs";
import { uuToScene } from "../src/shared/map-transform.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUTPUT = path.join(ROOT, "scripts", "data", "ctf-face-bsp.json");
const ACTORS = path.join(ROOT, "scripts", "data", "ctf-face-actors.json");

const arg = process.argv[2];
const MAPS = arg || path.join(os.homedir(), "Downloads", "Unreal Tournament", "Maps");
const MAP = MAPS.toLowerCase().endsWith(".unr") ? MAPS : path.join(MAPS, "CTF-Face.unr");

if (!fs.existsSync(MAP)) {
  console.error(`no such file: ${MAP}`);
  console.error(`this tool needs a retail UT99 install; pass the Maps directory as an argument.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// WHAT COUNTS AS SOLID
// ---------------------------------------------------------------------------
// PF_NotSolid is the engine's own word for "you pass through this" — decorative
// sheets, mostly, and every one of them in this level is also PF_TwoSided. PF_Portal
// is a zone divider: an invisible sheet the renderer cares about and a rocket does not.
//
// Everything else stays solid, including two that look like they should not:
//   PF_Semisolid (936 nodes) blocks players; semisolid is about how the BSP is CUT,
//     not about whether you can walk through it.
//   PF_FakeBackdrop (83 nodes) renders as sky but is still a wall. That is exactly
//     right for CTF-Face: the level is a sealed hull and you cannot rocket-jump out
//     of it in UT99 either.
const NOT_SOLID = PF.NotSolid | PF.Portal;

const buf = fs.readFileSync(MAP);
const pkg = loadPackage(buf);
const exp = findLevelModel(pkg);
const model = readModel(pkg, buf, exp, readProperties);
const { polys, skipped } = nodePolys(model);

console.log(`${path.basename(MAP)}  ->  ${exp.name} (${(exp.size / 1024).toFixed(0)} KB)`);
console.log(`  points ${model.points.length / 3}  nodes ${model.nodes.length}  surfs ${model.surfs.length}`);
console.log(`  node polygons ${polys.length}${skipped ? `  (${skipped} skipped for a bad vertex run)` : ""}`);

// ---------------------------------------------------------------------------
// DROPPING THE SKYBOX
// ---------------------------------------------------------------------------
// CTF-Face has two SkyZoneInfo actors and two backdrop rooms to go with them, and they
// are part of the same Model. They are sealed rooms nobody occupies, sitting 140+
// metres outside the level in scene space, so they separate cleanly as connected
// components. The alternative — decoding zones — needs actor Locations that are not in
// the property table.
//
// A component is kept if ANY of its points falls inside a box around Epic's own actor
// placements. The margin is generous on purpose: the nearest backdrop geometry is far
// enough away that anything from 40 to 200 metres would give the same answer, so this
// is not a fitted threshold holding two things apart by a hair.
const actors = JSON.parse(fs.readFileSync(ACTORS, "utf8"));
const placements = [...actors.flagBases, ...actors.playerStarts, ...actors.pickups];
let amn = [Infinity, Infinity, Infinity];
let amx = [-Infinity, -Infinity, -Infinity];
for (const a of placements) {
  const s = uuToScene(a.location.x, a.location.y, a.location.z);
  const v = [s.x, s.y, s.z];
  for (let k = 0; k < 3; k++) {
    if (v[k] < amn[k]) amn[k] = v[k];
    if (v[k] > amx[k]) amx[k] = v[k];
  }
}
const MARGIN = 30;
const inPlay = (i) => {
  const s = uuToScene(model.points[i * 3], model.points[i * 3 + 1], model.points[i * 3 + 2]);
  const v = [s.x, s.y, s.z];
  for (let k = 0; k < 3; k++) if (v[k] < amn[k] - MARGIN || v[k] > amx[k] + MARGIN) return false;
  return true;
};

const groups = components(polys);
const keep = new Set();
let droppedSky = 0;
let skyComponents = 0;
for (const g of groups) {
  const touches = g.some((i) => polys[i].idx.some(inPlay));
  if (touches) for (const i of g) keep.add(i);
  else {
    droppedSky += g.length;
    skyComponents++;
  }
}
console.log(
  `  ${groups.length} connected components; dropped ${skyComponents} of them ` +
    `(${droppedSky} polygons) as backdrop, ${MARGIN} m outside the actor box`,
);

// A level that is mostly backdrop means the play box is wrong, not that Epic built a
// strange map. Fail loudly rather than shipping an empty world.
if (keep.size < polys.length * 0.5) {
  throw new Error(`kept only ${keep.size} of ${polys.length} polygons — the play box is wrong`);
}

// ---------------------------------------------------------------------------
// TRIANGULATE
// ---------------------------------------------------------------------------
// A fan is valid because BSP node polygons are convex by construction.
const tris = [];
let droppedFlags = 0;
for (let i = 0; i < polys.length; i++) {
  if (!keep.has(i)) continue;
  const p = polys[i];
  if (p.polyFlags & NOT_SOLID) {
    droppedFlags++;
    continue;
  }
  for (let k = 1; k + 1 < p.idx.length; k++) tris.push([p.idx[0], p.idx[k], p.idx[k + 1]]);
}
console.log(`  dropped ${droppedFlags} polygons as NotSolid/Portal`);

// Re-index onto only the points the kept triangles actually use, so the JSON does not
// carry the backdrop's vertices.
const remap = new Map();
const outPoints = [];
const r3 = (n) => Math.round(n * 1000) / 1000;
const idxOf = (pt) => {
  let m = remap.get(pt);
  if (m === undefined) {
    m = outPoints.length / 3;
    remap.set(pt, m);
    outPoints.push(r3(model.points[pt * 3]), r3(model.points[pt * 3 + 1]), r3(model.points[pt * 3 + 2]));
  }
  return m;
};
const outTris = tris.map((t) => [idxOf(t[0]), idxOf(t[1]), idxOf(t[2])]);

const payload = {
  $comment: [
    "CTF-Face (UT99) collision geometry, lifted from the BSP in Epic's own CTF-Face.unr.",
    "GENERATED by scripts/build-ut-bsp.mjs from a retail install — do not hand-edit.",
    "points are raw Unreal Units in UT's axes (x forward, y right, z up); convert with",
    "uuToScene() in src/shared/map-transform.js. tris are index triples into points.",
    "Backdrop rooms and NotSolid/Portal surfaces are already removed; what is left is",
    "everything a projectile should stop at.",
  ],
  map: "CTF-Face",
  units: "unreal",
  source: { model: exp.name, nodes: model.nodes.length, surfs: model.surfs.length },
  dropped: { backdropPolygons: droppedSky, notSolidPolygons: droppedFlags, badVertexRuns: skipped },
  points: outPoints,
  tris: outTris,
};

fs.writeFileSync(OUTPUT, JSON.stringify(payload));
const kb = (fs.statSync(OUTPUT).size / 1024).toFixed(0);
console.log(`\nwrote ${path.relative(ROOT, OUTPUT)} — ${outTris.length} triangles, ${outPoints.length / 3} points, ${kb} KB`);
