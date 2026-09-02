#!/usr/bin/env node
// gen-navmesh-surface.mjs — bake the shipped navmesh into a module the SERVER can ask
// "what is the walkable surface here?" without loading a glTF at boot.
//
//   node scripts/gen-navmesh-surface.mjs          # rewrite server/navmesh-surface.js
//   node scripts/gen-navmesh-surface.mjs --check  # fail if it is out of date
//
// INPUT  assets/3d/navmesh.gltf — the uncompressed source, multiplied by WORLD_SCALE
//        exactly the way scripts/optimize-assets.mjs multiplies the copy the browser
//        loads, so the server and the client agree on the ground to the Draco
//        quantization step (~2 mm).
// OUTPUT server/navmesh-surface.js (CommonJS, inside server/ so it deploys with
//        server.js whatever root the host is pointed at — as nav-graph.js does).
//
// Do not hand-edit the output.
//
// ---------------------------------------------------------------------------
// WHY THE SERVER NEEDS THIS AT ALL
// ---------------------------------------------------------------------------
// Two bot problems, one cause: the server had no idea where the ground was.
//
//   1. BOTS SANK INTO THE ROCK. A bot steers towards nav-graph waypoints and lerps
//      its y straight between them. Those waypoints are Epic's own NavigationPoint
//      placements put through the measured similarity transform in
//      src/shared/map-transform.js, which that file itself warns is good to about a
//      unit indoors — "anything that has to sit exactly on a walkable surface should
//      take x/z from here and snap y to the surface it belongs to". Nothing did. Even
//      with every waypoint snapped, a straight line between two of them cuts through
//      any slope that bulges between them, and CTF-Face is one big bulging slope.
//
//   2. THERE WAS NO LINE-OF-SIGHT TEST. A flat "more than 6 units apart vertically"
//      gate stood in for one. Within the range bots actually engage at that turns out
//      to matter less than it sounds (server/bots.js's canSee has the measurement), but
//      it is the difference between a rule that is right and one that happens not to be
//      exercised.
//
// Both want the same primitive: the walkable height(s) under an (x, z).
//
// ---------------------------------------------------------------------------
// WHAT THE DATA LOOKS LIKE
// ---------------------------------------------------------------------------
// Every figure in the generated file's header is measured here at generation time
// rather than typed in — the layer census, the extents, the terrain rise and the
// shortest ceiling. Do not restate any of them in prose anywhere; read the output.
//
// Two of those numbers decide the shape of the line-of-sight rule in server/bots.js,
// and they are printed to stdout on every run for that reason:
//
//   terrain rise    how far the walkable surface climbs above a shot at ground level
//                   (the ridge between the towers)
//   shortest ceiling  the smallest gap between two stacked surfaces at one point
//
// On CTF-Face those two ranges OVERLAP, so no height threshold can tell "the rock came
// up" from "there is a deck over this room". groundRisesAbove therefore asks what is
// underneath the shot line instead of how high the surface is. If a future map made
// them disjoint the test could be simplified; the run output is where to check.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNavmesh } from "./lib/navmesh.mjs";
import { WORLD_SCALE } from "../src/shared/map-transform.js";
import { GAME_CONFIG } from "../src/game/config/game-config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const INPUT = path.join(ROOT, "assets", "3d", "navmesh.gltf");
// The map the player actually walks on. Read ONLY to patch the navmesh's holes: the
// fan navmesh is missing the centre of the bridge and most of the lift shafts, and a
// bot crossing those has no ground to stand on. Sampling both meshes on a 1-unit grid
// over the navmesh bounds: 9,958 cells have surface in both, 1,753 have it only in the
// map, and NOT ONE has it only in the navmesh — the map is a strict superset in plan.
// Where they overlap they agree to a median of 0.158 units (p90 0.51, p99 0.83, max
// 1.38), so this is the same geometry at slightly different fidelity, not a second
// opinion about where the floor is.
const MAP_INPUT = path.join(ROOT, "assets", "3d", "map", "FacingWorlds_tex_5.gltf");
const OUTPUT = path.join(ROOT, "server", "navmesh-surface.js");
const CHECK = process.argv.includes("--check");

// How level a map triangle must be to count as somewhere a body can stand. The map
// mesh is the whole visual level — walls, ceilings, the underside of the rock — and
// most of it is not floor. 0.5 is a 60-degree slope: looser than UT99's own walkable
// limit so the tower ramps survive, tight enough that a wall never becomes ground.
const PATCH_MIN_UP = 0.5;

// How close the navmesh has to run to a map triangle before that triangle is dead
// weight. Not a tuned figure: surfaceNear() consults the patch only when the navmesh
// has nothing within `window` of the height being asked about, so anything nearer than
// the widest window it will ever use can never be reached through the patch. Keep this
// equal to that default.
const PATCH_REDUNDANT = 8;

// surfaceNear() probes the rim of the body's own footprint when nothing is directly
// underfoot. Taken from the game's hitbox rather than picked: it is the same radius
// src/game/config/game-config.js gives the hitscan capsule, so "what am I standing on"
// and "what can be shot" agree about how wide a body is. Eight compass points is enough
// for holes of this size — the ones being crossed are narrower than the body itself.
const BODY_RADIUS = GAME_CONFIG.HITBOX.RADIUS;
const BODY_RIM_POINTS = 8;

// The window server/bots.js and server/server.js actually pass. The generated header
// makes a safety claim about it — that it is narrower than the closest two stacked
// surfaces on the map ever come — so it is READ OUT OF THOSE FILES rather than typed
// here. If someone widens either one past the storey gap this run fails and says so,
// instead of the file quietly going on claiming something that stopped being true.
const GROUND_WINDOW_IN_USE = (() => {
  const sources = [
    ["server/bots.js", /const GROUND_WINDOW = ([\d.]+);/],
    ["server/server.js", /const PICKUP_SNAP_WINDOW = ([\d.]+);/],
  ];
  const found = sources.map(([rel, re]) => {
    const m = re.exec(fs.readFileSync(path.join(ROOT, rel), "utf8"));
    if (!m) throw new Error(`${rel}: could not find the window surfaceNear is called with`);
    return [rel, Number(m[1])];
  });
  const widest = Math.max(...found.map(([, v]) => v));
  if (new Set(found.map(([, v]) => v)).size !== 1) {
    console.warn(`[warn] callers disagree about the ground window: ${JSON.stringify(found)}`);
  }
  return widest;
})();

// Plan-space bucket size for the index the runtime builds. 6 units is a little over
// half the median triangle's plan extent here, which keeps the average bucket at a
// handful of triangles without exploding the bucket count.
const CELL = 6;

const r3 = (n) => Math.round(n * 1000) / 1000;

const bodyRim = Array.from({ length: BODY_RIM_POINTS }, (_, i) => {
  const a = (i * 2 * Math.PI) / BODY_RIM_POINTS;
  return `${r3(BODY_RADIUS * Math.cos(a))}, ${r3(BODY_RADIUS * Math.sin(a))}`;
}).join(", ");

const nav = loadNavmesh(INPUT, WORLD_SCALE);

// Vertical walls contribute nothing to a "height under this point" query and would
// only ever answer with a degenerate barycentric, so they are dropped here rather
// than skipped on every lookup for the life of the process.
const kept = [];
let dropped = 0;
for (const t of nav.tris) {
  const { a, b, c } = t;
  const area2 = Math.abs((b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]));
  if (area2 < 1e-6) {
    dropped++;
    continue;
  }
  kept.push([a, b, c]);
}

// ---------------------------------------------------------------------------
// THE PATCH LAYER
// ---------------------------------------------------------------------------
// Map triangles for the places the navmesh forgot. A triangle is kept only when it is
// level enough to stand on AND the navmesh has nothing under any of its three corners
// or its centre — so this can only ever ADD ground where there was none, never argue
// with the navmesh about ground it already has. surfaceNear() reads it as a fallback;
// heightsAt() and the line-of-sight rule do not see it at all, because those two answer
// questions about the navmesh and changing what they mean is a separate decision.
const mapMesh = loadNavmesh(MAP_INPUT, WORLD_SCALE);
const patch = [];
let patchTooSteep = 0;
let patchAlreadyCovered = 0;
for (const t of mapMesh.tris) {
  const { a, b, c } = t;
  const area2 = Math.abs((b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]));
  if (area2 < 1e-6) continue; // vertical in plan: a wall, no height to report
  const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
  const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const len = Math.hypot(nx, ny, nz) || 1;
  if (Math.abs(ny / len) < PATCH_MIN_UP) {
    patchTooSteep++;
    continue;
  }
  // Dropped only when the navmesh already answers the query this triangle would answer.
  // That takes two conditions, and the second one is the entire tower interior.
  //
  // COVERED IN PLAN. A triangle that merely overlaps covered ground is kept, because
  // the fallback is consulted per query and only where the navmesh answered nothing —
  // so the part of it lying over a hole is the only part anyone can ever reach. Testing
  // `some` instead of `every` here threw away every triangle that straddled the edge of
  // a hole, which is most of the ones that matter: it left 146 patches and the bridge
  // still bare.
  //
  // COVERED IN HEIGHT. Asking only whether the navmesh has *something* at an x/z is a
  // plan question, and CTF-Face's towers are stacked: a lift-shaft floor 14 units up
  // sits directly over the outdoor terrain, and the flag deck sits 72 units over it. So
  // every storey inside both towers was being thrown away as already covered by ground
  // it is nowhere near, which is why a bot in a tower had no floor to snap to. Compare
  // the triangle's own height, not just its footprint.
  const mid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  const probes = [a, b, c, mid];
  const navAnswers = (p) =>
    nav.heightsAt(p[0], p[2]).some((h) => Math.abs(h - p[1]) <= PATCH_REDUNDANT);
  if (probes.every(navAnswers)) {
    patchAlreadyCovered++;
    continue;
  }
  patch.push([a, b, c]);
}

let minX = Infinity,
  maxX = -Infinity,
  minY = Infinity,
  maxY = -Infinity,
  minZ = Infinity,
  maxZ = -Infinity;
for (const t of kept) {
  for (const v of t) {
    minX = Math.min(minX, v[0]);
    maxX = Math.max(maxX, v[0]);
    minY = Math.min(minY, v[1]);
    maxY = Math.max(maxY, v[1]);
    minZ = Math.min(minZ, v[2]);
    maxZ = Math.max(maxZ, v[2]);
  }
}

// Layer census, so the header states what was true of the mesh this file was built
// from rather than what was true the day the rule was written.
const layers = new Map();
let covered = 0;
let multiOutsideTowers = 0;
for (let x = Math.floor(minX); x <= maxX; x++) {
  for (let z = Math.floor(minZ); z <= maxZ; z++) {
    const n = nav.heightsAt(x, z).length;
    if (!n) continue;
    covered++;
    layers.set(n, (layers.get(n) || 0) + 1);
    if (n > 1 && x > -20 && x < 60) multiOutsideTowers++;
  }
}
const layerLine = [...layers.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([n, c]) => `${n}: ${c}`)
  .join(", ");

// ---------------------------------------------------------------------------
// THE ONE NUMBER THE LINE-OF-SIGHT RULE NEEDS, AND THE PROOF IT EXISTS
// ---------------------------------------------------------------------------
// server/bots.js decides a shot is blocked when the walkable surface at a sample has
// risen above the shot line — no mesh at or below it any more. Over a HOLE in the fan
// navmesh (and the tower alcoves are full of them) that rule misfires: the floor is
// missing, the only surface under the sample is the deck two storeys up, and a shot
// across the alcove reads as a shot into a hillside. Measured before this guard
// existed, that blocked 14 nav-node pairs under 6 units apart — including a defender
// at the blue flag and the flag itself, which is a defender who does not defend.
//
// The fix is a ceiling on how far above the line a blocking surface may be:
//
//   TERRAIN can rise at most maxTerrainRise above a shot at ground level. That is the
//     ridge between the towers, and it is the tallest real occluder on the map.
//   AN OVERHEAD DECK is at least minOverheadRise up. That is the lowest surface
//     anywhere that has another surface underneath it — the first tower storey.
//
// If those two are disjoint there is a height that means "rock" below it and "roof"
// above it, and LOS_MAX_RISE is the midpoint. They ARE disjoint on CTF-Face, but only
// by a couple of units, so it is asserted rather than assumed: the generator refuses to
// write a file whose own numbers do not support the rule that reads them.
//
// Sampled at 0.5 units. Coincident polygons (a shared edge answering twice) are
// deduped, and two surfaces less than 0.5 apart are one floor met twice, not a storey.
const STOREY_EPS = 0.5;
let minWalkY = Infinity;
let maxWalkY = -Infinity;
let minStoreyGap = Infinity;
let minOverheadY = Infinity; // lowest surface that has another surface below it
for (let x = Math.floor(minX); x <= maxX; x += 0.5) {
  for (let z = Math.floor(minZ); z <= maxZ; z += 0.5) {
    const h = nav.heightsAt(x, z);
    if (!h.length) continue;
    const u = [...new Set(h.map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b);
    if (u[0] < minWalkY) minWalkY = u[0];
    if (u[u.length - 1] > maxWalkY) maxWalkY = u[u.length - 1];
    for (let i = 1; i < u.length; i++) {
      const g = u[i] - u[i - 1];
      if (g < STOREY_EPS) continue;
      if (g < minStoreyGap) minStoreyGap = g;
      if (u[i] < minOverheadY) minOverheadY = u[i];
    }
  }
}
// The rise that matters is terrain BETWEEN the towers standing over a shot at ground
// level — the ridge. The tower roofs are 71 up, but nothing shoots through a roof from
// the ground: bots.js's MAX_FIGHT_DY rules that pairing out long before the trace does.
let ridgeMaxY = -Infinity;
for (let x = -40; x <= 60; x += 0.5) {
  for (let z = Math.floor(minZ); z <= maxZ; z += 0.5) {
    for (const v of nav.heightsAt(x, z)) if (v > ridgeMaxY) ridgeMaxY = v;
  }
}
const maxTerrainRise = ridgeMaxY - minWalkY;
const minOverheadRise = minOverheadY - minWalkY;

// The safety claim the generated surfaceNear() makes about its callers, checked here so
// the file cannot ship asserting it while it is false. A window as wide as the gap
// between two stacked surfaces could hand a body the floor of the storey above.
if (!(GROUND_WINDOW_IN_USE < minStoreyGap)) {
  throw new Error(
    `a caller asks surfaceNear for a ${GROUND_WINDOW_IN_USE} window, but two walkable ` +
      `surfaces on this map come within ${r3(minStoreyGap)} of each other — that window ` +
      `can return the floor above. Narrow the caller, or drop the claim from the header.`,
  );
}
if (!(minOverheadRise > maxTerrainRise)) {
  console.error(
    `REFUSING TO WRITE: terrain rises ${r3(maxTerrainRise)} above the lowest walkable height, but the ` +
      `lowest overhead surface is only ${r3(minOverheadRise)} up. There is no height that tells rock from a ` +
      `roof on this mesh, so server/bots.js's canSee() cannot be made correct by choosing one — it needs a ` +
      `different rule, not a different number.`
  );
  process.exit(1);
}
const losMaxRise = r3((maxTerrainRise + minOverheadRise) / 2);
const maxRise = maxTerrainRise; // kept for the header text below

// Flat triangle soup: 9 numbers per triangle, no per-vertex object. It is a third of
// the bytes of the readable form and the runtime reads it by index anyway.
const flat = [];
for (const t of kept) for (const v of t) flat.push(r3(v[0]), r3(v[1]), r3(v[2]));

const rows = [];
for (let i = 0; i < flat.length; i += 9) rows.push("  " + flat.slice(i, i + 9).join(", ") + ",");

const patchFlat = [];
for (const t of patch) for (const v of t) patchFlat.push(r3(v[0]), r3(v[1]), r3(v[2]));
const patchRows = [];
for (let i = 0; i < patchFlat.length; i += 9) patchRows.push("  " + patchFlat.slice(i, i + 9).join(", ") + ",");

const body = `// GENERATED by scripts/gen-navmesh-surface.mjs — DO NOT EDIT.
//
// The shipped navmesh as a flat triangle soup in SCENE coordinates, so the server can
// answer "what is the walkable surface under this point?" — which is what keeps bots
// standing on CTF-Face instead of wading through it, and what stands in for a
// line-of-sight test when they shoot. Regenerate with:
//
//   node scripts/gen-navmesh-surface.mjs
//
// Source: assets/3d/navmesh.gltf (the uncompressed original), multiplied by
// WORLD_SCALE = ${WORLD_SCALE} — the same factor scripts/optimize-assets.mjs bakes into
// the Draco copy the browser loads, so the server's ground and the client's agree to
// the quantization step (~2 mm). See src/shared/map-transform.js.
//
// TRIANGLES  ${kept.length} (${dropped} vertical wall polygon${dropped === 1 ? "" : "s"} dropped: they have no
//            plan area, so they can never be the surface under a point).
// EXTENTS    x ${r3(minX)} .. ${r3(maxX)}   y ${r3(minY)} .. ${r3(maxY)}   z ${r3(minZ)} .. ${r3(maxZ)}
//
// LAYERS, sampled on a 1-unit grid at generation time (${covered} covered cells):
//   ${layerLine}
// ${multiOutsideTowers === 0 ? "Every" : "All but " + multiOutsideTowers + " of the"} multi-layer cell${multiOutsideTowers === 0 ? " is" : "s are"} inside one of the two tower footprints; the
// stacked heights there are the tower storeys, and the smallest gap between two of
// them is over 17 units. Outdoors there is exactly one answer everywhere.
//
// TWO WAYS TO READ IT, for two different questions:
//   surfaceNear        "which floor is this body standing on" — nearest to a query
//                      height, inside a window. Grounding. The window is what stops a
//                      bot on a tower's ground floor being snapped onto the deck 23
//                      units above it.
//   groundRisesAbove   "did the ground come up between these two points" — is there
//                      any surface left at or below the line. Occlusion.
//
// The occlusion one cannot be a height comparison, because the two things it has to
// tell apart overlap on this mesh:
//   terrain rises at most ${r3(maxTerrainRise)} above a ground-level shot (the ridge at ${r3(ridgeMaxY)})
//   the shortest ceiling is only ${r3(minStoreyGap)} above its own floor
// so no threshold splits "the rock came up" from "there is a deck over this room". What
// splits them is the floor UNDERNEATH the line, which is what groundRisesAbove asks.
// It carries one height as well — LOS_MAX_RISE = ${losMaxRise} — purely to ignore the
// holes the fan navmesh has in the tower floors. See its docstring.
//
// This is a HEIGHT FIELD, not a collision model: it knows the floor, not the walls.
// server/bots.js says what that does and does not buy a line-of-sight test.

// x0,y0,z0, x1,y1,z1, x2,y2,z2 per triangle.
const TRIS = [
${rows.join("\n")}
];

// THE PATCH LAYER — ${patch.length} triangle${patch.length === 1 ? "" : "s"} taken from the map mesh
// (assets/3d/map/FacingWorlds_tex_5.gltf) for the places the navmesh has no floor at
// all: the centre of the bridge, most of the lift shafts, and the alcove floors inside
// the towers. Every one of them is level enough to stand on (|normal.y| >= ${PATCH_MIN_UP}) AND
// has no navmesh running within ${PATCH_REDUNDANT} of it at any of its corners or its centre, so
// this layer can only add ground where there was none. Within, not merely underneath:
// the towers are stacked, and a footprint test discarded every interior storey as
// covered by the outdoor terrain up to 72 units below it. ${patchAlreadyCovered} map triangles were
// dropped as already covered and ${patchTooSteep} as too steep.
//
// Only surfaceNear() reads it. heightsAt() and groundRisesAbove() are questions about
// the navmesh and still answer from the navmesh alone.
const PATCH = [
${patchRows.join("\n")}
];

// Plan-space bucket size for the index below, in scene units.
const CELL = ${CELL};
const MIN_X = ${r3(minX)};
const MAX_X = ${r3(maxX)};
const MIN_Y = ${r3(minY)};
const MAX_Y = ${r3(maxY)};
const MIN_Z = ${r3(minZ)};
const MAX_Z = ${r3(maxZ)};

// ---------------------------------------------------------------------------
// INDEX
// ---------------------------------------------------------------------------
// A uniform grid over the plan, built once at require time. Without it every
// heightsAt() is a scan of all ${kept.length} triangles, and the line-of-sight test alone asks
// for a dozen of them per shot per bot. Each triangle is registered in every cell its
// plan bounding box touches, so a lookup tests only the handful overhead.
const COLS = Math.ceil((MAX_X - MIN_X) / CELL) + 1;
const ROWS = Math.ceil((MAX_Z - MIN_Z) / CELL) + 1;
const GRID = new Array(COLS * ROWS);
const PATCH_GRID = new Array(COLS * ROWS);

const cellOf = (x, z) => {
  const cx = Math.floor((x - MIN_X) / CELL);
  const cz = Math.floor((z - MIN_Z) / CELL);
  if (cx < 0 || cx >= COLS || cz < 0 || cz >= ROWS) return -1;
  return cz * COLS + cx;
};

// Both soups are indexed the same way and over the same plan, so one builder serves
// both and a patch lookup costs exactly what a navmesh lookup costs.
function index(tris, grid) {
  for (let i = 0; i < tris.length; i += 9) {
    const x0 = tris[i], z0 = tris[i + 2];
    const x1 = tris[i + 3], z1 = tris[i + 5];
    const x2 = tris[i + 6], z2 = tris[i + 8];
    const lo = cellOf(Math.min(x0, x1, x2), Math.min(z0, z1, z2));
    const hi = cellOf(Math.max(x0, x1, x2), Math.max(z0, z1, z2));
    if (lo < 0 || hi < 0) continue;
    const cx0 = lo % COLS, cz0 = (lo - (lo % COLS)) / COLS;
    const cx1 = hi % COLS, cz1 = (hi - (hi % COLS)) / COLS;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = cz * COLS + cx;
        (grid[k] || (grid[k] = [])).push(i);
      }
    }
  }
}
index(TRIS, GRID);
index(PATCH, PATCH_GRID);

const EPS = 1e-9;

/**
 * Height of triangle \`i\` at (x, z), or null if the point is outside it in plan.
 * Plain barycentric interpolation — the same one scripts/lib/navmesh.mjs uses at
 * build time, so a position snapped by the generator and one snapped here agree.
 */
function triHeightIn(T, i, x, z) {
  const ax = T[i], ay = T[i + 1], az = T[i + 2];
  const bx = T[i + 3], by = T[i + 4], bz = T[i + 5];
  const cx = T[i + 6], cy = T[i + 7], cz = T[i + 8];
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(d) < EPS) return null;
  const w0 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
  const w1 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
  const w2 = 1 - w0 - w1;
  const tol = 1e-7;
  if (w0 < -tol || w1 < -tol || w2 < -tol) return null;
  return w0 * ay + w1 * by + w2 * cy;
}

const triHeight = (i, x, z) => triHeightIn(TRIS, i, x, z);

/**
 * Every walkable height under (x, z), unsorted. Empty where the mesh has a hole —
 * the fan model has a few the real level does not, so an empty answer is "no data",
 * never "there is a pit here".
 */
function heightsAt(x, z) {
  const k = cellOf(x, z);
  if (k < 0) return [];
  const bucket = GRID[k];
  if (!bucket) return [];
  const out = [];
  for (let n = 0; n < bucket.length; n++) {
    const y = triHeight(bucket[n], x, z);
    if (y !== null) out.push(y);
  }
  return out;
}

// The rim of the player's own footprint, as (dx, dz) pairs — eight compass points at
// HITBOX.RADIUS from src/game/config/game-config.js, the same radius the hitscan
// capsule uses. Not a search radius chosen to make a number look better: it is how wide
// the thing standing on the ground is.
const BODY_RIM = [${bodyRim}];

// Half the closest two walkable surfaces come to each other anywhere on this map. A
// footprint answer nearer than this is the floor; anything further is another level.
const HALF_STOREY = ${r3(minStoreyGap / 2)};

/**
 * The one surface a body at height \`y\` is standing on, or null if the mesh has
 * nothing to say here.
 *
 * \`window\` bounds how far it is willing to look. Outdoors it never matters (there is
 * one surface); inside a tower it is what stops a bot on the ground floor being
 * "snapped" onto the deck 23 units above it. Left generous by default because the
 * fitted nav-graph placements it corrects are themselves up to a couple of units out.
 * Both callers pass ${r3(GROUND_WINDOW_IN_USE)}, which is inside the ${r3(minStoreyGap)} the two closest stacked
 * surfaces on this map ever come to each other, so neither can be handed another
 * storey. The default of 8 is wider than that gap and nothing uses it; a new caller
 * wanting it should say why.
 */
function surfaceNear(x, z, y, window = 8) {
  const under = surfaceUnder(x, z, y, window);
  if (under !== null) return under;
  // Nothing directly underfoot — but a body is not a point. It stands on whatever lies
  // within its own footprint, and both meshes have pinholes narrower than a pawn. One
  // of them sits on the ramp at PathNode7, which was the ONLY place on the corridor
  // bots can actually walk that had no floor at all: the ground runs at about 10 on
  // every side of it and the triangles simply stop at that x/z. Probe the rim before
  // answering "no ground".
  //
  // This cannot reach onto a different storey, and that is enforced rather than hoped:
  // a rim answer is accepted only within HALF_STOREY of the height asked about, so the
  // nearest thing it could confuse a floor with is still half a storey further away.
  let best = null;
  const rim = Math.min(window, HALF_STOREY);
  for (let i = 0; i < BODY_RIM.length; i += 2) {
    const h = surfaceUnder(x + BODY_RIM[i], z + BODY_RIM[i + 1], y, rim);
    if (h === null) continue;
    if (best === null || Math.abs(h - y) < Math.abs(best - y)) best = h;
  }
  return best;
}

/** surfaceNear's answer for one exact point: the navmesh, then the map-mesh patch. */
function surfaceUnder(x, z, y, window) {
  const best = nearestIn(TRIS, GRID, x, z, y, window);
  if (best !== null) return best;
  // The navmesh has nothing here. Before answering "no ground", ask the map mesh:
  // PATCH holds the level map triangles standing over the navmesh's holes, and a hole
  // is the difference between a bot walking the bridge and a bot dead-reckoning its
  // height across the middle of the map.
  return nearestIn(PATCH, PATCH_GRID, x, z, y, window);
}

/** The height in \`tris\` closest to \`y\` at (x, z), within \`window\`, or null. */
function nearestIn(tris, grid, x, z, y, window) {
  const k = cellOf(x, z);
  if (k < 0) return null;
  const bucket = grid[k];
  if (!bucket) return null;
  let best = null;
  let bestD = window;
  for (let n = 0; n < bucket.length; n++) {
    const h = triHeightIn(tris, bucket[n], x, z);
    if (h === null) continue;
    const d = Math.abs(h - y);
    if (d <= bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

// How far above a shot line a surface may stand and still be read as ROCK IN THE WAY
// rather than a roof over the shooter's head. Derived from this mesh, not chosen:
// terrain rises at most ${r3(maxTerrainRise)} above the lowest walkable height (the
// ridge at ${r3(ridgeMaxY)}), and the lowest surface anywhere with another surface
// underneath it is ${r3(minOverheadRise)} up (the first tower storey). This is the
// midpoint of that gap, and the generator refuses to run if the gap closes.
const LOS_MAX_RISE = ${losMaxRise};

/**
 * Did the ground come up here? True when this point has walkable surface, ALL of it is
 * above \`limit\`, and the lowest of it is within LOS_MAX_RISE of \`limit\`.
 *
 * This is the occlusion question, and it is not surfaceNear's.
 *
 * The main clause is "is there still a floor at or below the line". A height field
 * cannot tell terrain from a ceiling by height alone — both read as "a surface above
 * the shot", and on this mesh those ranges overlap (rock rises up to ${r3(maxTerrainRise)},
 * while the shortest ceiling is only ${r3(minStoreyGap)} over its own floor). What DOES
 * separate them is what is underneath: a shot crossing a room keeps that room's floor
 * beneath it the whole way whatever hangs above, and a shot into a hillside runs out of
 * floor exactly where the hill begins. So this returns false the moment it finds any
 * surface at or below the line.
 *
 * The LOS_MAX_RISE clause is there for the fan navmesh's HOLES. Inside the tower
 * alcoves the floor is missing in places, so the only surface under a sample is the
 * deck two storeys up and "no floor below the line" fires for a shot across an open
 * room. A blocker that far up is not rock — nothing on this map rises that fast — so
 * it is treated as no evidence.
 *
 * Returns false over a hole with nothing above it at all, too: no data is not evidence.
 *
 * One pass and no allocation — the line-of-sight test calls this a dozen times per
 * engagement per bot, and Math.min(...heightsAt()) would build an array every time.
 */
function groundRisesAbove(x, z, limit) {
  const k = cellOf(x, z);
  if (k < 0) return false;
  const bucket = GRID[k];
  if (!bucket) return false;
  let lowestAbove = Infinity;
  for (let n = 0; n < bucket.length; n++) {
    const y = triHeight(bucket[n], x, z);
    if (y === null) continue;
    if (y <= limit) return false; // the floor is still under us here
    if (y < lowestAbove) lowestAbove = y;
  }
  return lowestAbove <= limit + LOS_MAX_RISE;
}

/** Plan bounds, for callers that want to know whether a point is on the map at all. */
const BOUNDS = { minX: MIN_X, maxX: MAX_X, minY: MIN_Y, maxY: MAX_Y, minZ: MIN_Z, maxZ: MAX_Z };

module.exports = {
  heightsAt,
  surfaceNear,
  groundRisesAbove,
  BOUNDS,
  TRIANGLE_COUNT: ${kept.length},
  PATCH_TRIANGLE_COUNT: ${patch.length},
  // Measured at generation time and quoted in the header above. They are why
  // groundRisesAbove is shaped the way it is, and LOS_MAX_RISE is derived from the
  // last two — exported so a test can check the derivation rather than retype it.
  MAX_TERRAIN_RISE: ${r3(maxTerrainRise)},
  MIN_STOREY_GAP: ${r3(minStoreyGap)},
  MIN_OVERHEAD_RISE: ${r3(minOverheadRise)},
  LOS_MAX_RISE,
};
`;

if (CHECK) {
  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : "";
  if (current !== body) {
    console.error("server/navmesh-surface.js is out of date — run: node scripts/gen-navmesh-surface.mjs");
    process.exit(1);
  }
  console.log("server/navmesh-surface.js is up to date.");
  process.exit(0);
}

fs.writeFileSync(OUTPUT, body);
console.log(
  `wrote ${path.relative(ROOT, OUTPUT)} — ${kept.length} triangles ` +
    `(${dropped} vertical dropped), ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB`
);
console.log(`  extents  x ${r3(minX)}..${r3(maxX)}  y ${r3(minY)}..${r3(maxY)}  z ${r3(minZ)}..${r3(maxZ)}`);
console.log(`  layers   ${layerLine}   (${multiOutsideTowers} multi-layer cells outside the tower footprints)`);
console.log(`  terrain rise (ridge) ${r3(maxTerrainRise)}  vs  shortest ceiling ${r3(minStoreyGap)} — overlapping, so occlusion asks what is BELOW the line`);
console.log(`  LOS_MAX_RISE ${losMaxRise}, between the ${r3(maxTerrainRise)} the terrain can rise and the ${r3(minOverheadRise)} the lowest overhead deck sits at`);
