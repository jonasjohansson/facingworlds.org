#!/usr/bin/env node
// gen-nav-graph.mjs — turn Epic's CTF-Face PATH NETWORK into a graph the server
// can path bots over.
//
//   node scripts/gen-nav-graph.mjs          # rewrite server/nav-graph.js
//   node scripts/gen-nav-graph.mjs --check  # fail if it is out of date (CI/pre-commit)
//
// INPUT  scripts/data/ctf-face-nav.json — 166 NavigationPoints and the 592 directed
//        edges between them, in Unreal Units, exactly as Epic's level compiler left
//        them in CTF-Face.unr. Coordinates, class names and graph topology only: no
//        Epic art, geometry, sound or text is in this repo, and none should ever be.
//        A path edge is a fact about a level layout, not an asset.
// OUTPUT server/nav-graph.js (CommonJS — server/ has no "type": "module", and the
//        file lives inside server/ so it deploys with server.js whatever root
//        directory the host is pointed at, exactly like server/map-actors.js).
//
// Do not hand-edit the output.
//
// ---------------------------------------------------------------------------
// WHERE THE EDGES COME FROM — AND WHY THEY ARE REAL
// ---------------------------------------------------------------------------
// They are Epic's own FReachSpecs, not anything this repo invented or inferred.
//
// A UT99 map does not ship a navmesh. It ships a graph: every NavigationPoint
// (PathNode, InventorySpot, PlayerStart, FlagBase, Teleporter, LiftExit,
// DefensePoint, AmbushPoint, TranslocDest) carries `Paths[16]` and
// `upstreamPaths[16]`, which are indices into one level-wide `TArray<FReachSpec>`
// serialized inside the ULevel object itself — after the actor list, the FURL and
// the Model reference. Each FReachSpec is
//
//     INT distance, ref Start, ref End, INT CollisionRadius, INT CollisionHeight,
//     INT reachFlags, BYTE bPruned
//
// which is where the direction, the length, the "how big a pawn fits" numbers and
// the walk/jump/teleport kind of every connection live.
//
// The dump was produced by the ULevel walk in export_nav.py (kept out of the repo
// with the rest of the .unr tooling). It cross-checks itself rather than trusting
// the byte walk: for every actor A and every A.Paths[k] = j it asserts
// ReachSpecs[j].Start === A, and for every A.upstreamPaths[k] = j it asserts
// ReachSpecs[j].End === A. On CTF-Face that is 1184 assertions and all 1184 hold,
// and the number of non-pruned specs (592) is exactly the number of Paths[]
// entries. Two independently serialized halves of the file agree perfectly, so the
// decode is verified, not plausible.
//
// bPruned specs (364 of the 956) are dropped: the path compiler marks a spec pruned
// when it is redundant with a chain of others, and UT's own bots never walk them.
//
// If the decode had failed, export_nav.py would have fallen back to synthesizing
// edges by proximity and stamped edgeSource:"synthesized-proximity" on the dump.
// This generator refuses to emit anything without saying which it got, and the
// header of the generated file says so too.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UU_TO_M, OFFSET, uuToScene } from "../src/shared/map-transform.js";
import { FLAG_HOMES, SPAWNS } from "../src/shared/map-actors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const INPUT = path.join(ROOT, "scripts", "data", "ctf-face-nav.json");
const OUT_CJS = path.join(ROOT, "server", "nav-graph.js");

// How far a FlagBase or PlayerStart is allowed to be from the nearest graph node
// before this generator refuses to write. The two sets describe the same actors, so
// the only gap is the navmesh snapping map-actors.js applies and the fit residual —
// about 1.7 units at worst. 8 is a loose bound that would still catch a transform,
// axis or unit mistake immediately.
const OBJECTIVE_NODE_TOLERANCE = 8;

const r2 = (n) => Math.round(n * 100) / 100;
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// ---------------------------------------------------------------------------

const src = JSON.parse(fs.readFileSync(INPUT, "utf8"));
const SYNTHESIZED = src.edgeSource !== "reachspecs";

const nodes = src.nodes.map((n) => {
  if (!n.location) throw new Error(`nav node ${n.name} has no Location`);
  const p = uuToScene(n.location.x, n.location.y, n.location.z);
  const out = { id: n.id, cls: n.class, name: n.name, x: r2(p.x), y: r2(p.y), z: r2(p.z) };
  // UT's Team/TeamNumber: 0 is red, 1 is blue. Carried through so a bot can ask for
  // "a DefensePoint on my side" without re-deriving which end of the map it is.
  const team = n.class === "PlayerStart" ? n.TeamNumber : n.Team;
  if (team === 0 || team === 1) out.team = team === 0 ? "red" : "blue";
  return out;
});
const byId = new Map(nodes.map((n) => [n.id, n]));

// Epic's `distance` is a path length in UU, so scaling it by UU_TO_M puts a cost in the
// same units as the node coordinates — which is what makes the straight-line heuristic
// in aStar() admissible.
//
// Two wrinkles, both real and both handled here rather than left for a caller to trip
// over:
//
//  1. UT's path builder truncates the length to an INT, so a walk spec is up to 1 UU
//     (0.024 scene units) SHORTER than the straight line between its two endpoints.
//     Almost every edge is: 558 of the 560 walk/jump specs on CTF-Face, by a median of
//     0.45 UU and never more than 0.99. An edge cheaper than the heuristic across it
//     turns A* into something that quietly returns non-optimal routes, so walk/jump
//     costs are floored at the straight line. It is a sub-centimetre correction.
//
//  2. R_SPECIAL specs — teleporters and translocator pads — do NOT carry a real length.
//     UT gives them a flat nominal cost (100 UU here) precisely because the traversal
//     is instantaneous, and the worst of them spans 2882 UU of actual map. Flooring
//     those would throw away the one thing the number is saying. They are left exactly
//     as Epic wrote them, and aStar() drops its heuristic to zero — degrading cleanly
//     to Dijkstra, which is optimal for any non-negative costs — whenever it is asked
//     to use them.
const R_SPECIAL = 32;
let flooredWalk = 0;
const edges = src.edges.map((e) => {
  const a = byId.get(e.from);
  const b = byId.get(e.to);
  if (!a || !b) throw new Error(`edge ${e.from}->${e.to} references a missing node`);
  let cost = e.distance * UU_TO_M;
  if (!(e.flags & R_SPECIAL)) {
    const straight = dist3(a, b);
    if (cost < straight) {
      cost = straight;
      flooredWalk++;
    }
  }
  return { from: e.from, to: e.to, cost: r2(cost), flags: e.flags };
});

// ---------------------------------------------------------------------------
// connectivity
// ---------------------------------------------------------------------------
function components(edgeList) {
  const adj = nodes.map(() => []);
  for (const e of edgeList) {
    adj[e.from].push(e.to);
    adj[e.to].push(e.from);
  }
  const comp = new Array(nodes.length).fill(-1);
  const groups = [];
  for (let i = 0; i < nodes.length; i++) {
    if (comp[i] >= 0) continue;
    const g = [];
    const stack = [i];
    comp[i] = groups.length;
    while (stack.length) {
      const v = stack.pop();
      g.push(v);
      for (const w of adj[v]) {
        if (comp[w] < 0) {
          comp[w] = groups.length;
          stack.push(w);
        }
      }
    }
    groups.push(g);
  }
  groups.sort((a, b) => b.length - a.length);
  return groups;
}

const allComponents = components(edges);
const walkEdges = edges.filter((e) => !(e.flags & R_SPECIAL));
const walkComponents = components(walkEdges);
const walkMain = new Set(walkComponents[0]);

// ---------------------------------------------------------------------------
// sanity: every objective the game actually uses has a node next to it
// ---------------------------------------------------------------------------
const nearestTo = (p) => {
  let best = null;
  let bestD = Infinity;
  for (const n of nodes) {
    const d = dist3(n, p);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return { node: best, dist: bestD };
};

const failures = [];
const checks = [];
const check = (label, p) => {
  const { node, dist } = nearestTo(p);
  checks.push({ label, node: node.name, dist, inWalkMain: walkMain.has(node.id) });
  if (dist > OBJECTIVE_NODE_TOLERANCE) {
    failures.push(`${label} at (${r2(p.x)}, ${r2(p.y)}, ${r2(p.z)}) has no nav node within ` +
      `${OBJECTIVE_NODE_TOLERANCE} units — nearest is ${node.name} at ${dist.toFixed(2)}`);
  }
  if (!walkMain.has(node.id)) {
    failures.push(`${label}'s nearest node ${node.name} is not in the main walkable component`);
  }
};
for (const team of ["red", "blue"]) check(`FLAG_HOMES.${team}`, FLAG_HOMES[team]);
for (const team of ["red", "blue"]) {
  for (const s of SPAWNS[team]) check(`SPAWNS.${team} ${s.ut}`, s);
}

if (failures.length) {
  console.error("\nNAV GRAPH SANITY CHECK FAILED — refusing to write:\n  " + failures.join("\n  "));
  process.exit(1);
}

const worst = checks.reduce((m, c) => Math.max(m, c.dist), 0);

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------
const j = (v) => JSON.stringify(v);
const byClass = {};
for (const n of nodes) byClass[n.cls] = (byClass[n.cls] || 0) + 1;
const classLine = Object.keys(byClass)
  .sort()
  .map((k) => `${byClass[k]} ${k}`)
  .join(", ");

const compLine = (groups) =>
  groups.length === 1
    ? `one connected component (all ${groups[0].length} nodes)`
    : `${groups.length} components, sizes [${groups.map((g) => g.length).join(", ")}]`;

const strayNodes = walkComponents
  .slice(1)
  .map((g) => `${g.length}: ${g.map((i) => byId.get(i).name).join(", ")}`);

const text = `// GENERATED by scripts/gen-nav-graph.mjs — DO NOT EDIT.
//
// CTF-Face's real path network — the graph UT99's own bots walk — converted from
// Unreal Units to this game's scene coordinates by src/shared/map-transform.js.
// Regenerate with:
//
//   node scripts/gen-nav-graph.mjs
//
// Source: scripts/data/ctf-face-nav.json.
//
// EDGES ARE ${SYNTHESIZED ? "SYNTHESIZED, NOT EPIC'S" : "EPIC'S OWN"}.
${
  SYNTHESIZED
    ? `// The ReachSpec decode failed, so the connections below were INVENTED by proximity
// (3D distance under 700 UU with under 100 UU of height difference, plus each node's
// three nearest). They are a guess at where you can walk, not a fact about the level.`
    : `// Every edge is one non-pruned FReachSpec out of the TArray<FReachSpec> serialized
// inside the .unr's ULevel object: Epic's path compiler wrote them, and each carries
// its own direction, length and reach kind. The dump cross-checks the ReachSpec table
// against all ${src.diagnostics?.crossChecked ?? "?"} Paths[]/upstreamPaths[] entries on the NavigationPoints
// themselves and every one agrees, so this is a verified decode rather than a
// plausible one. The ${src.diagnostics?.prunedSpecs ?? "?"} specs the compiler marked bPruned (redundant with a
// chain of others) are left out, exactly as UT's bots leave them out.`
}
//
// NODES  ${nodes.length} NavigationPoints — ${classLine}.
// EDGES  ${edges.length}, DIRECTED. Epic's graph is not symmetric: a drop you can fall down
//        but not climb back up is one spec, not two. Do not assume \`to\`/\`from\` reverse.
//
// COORDINATES are scene units, straight through uuToScene() with no navmesh snapping —
// the honest conversion of Epic's placement, good to roughly a unit indoors and better
// outdoors (see the residuals in src/shared/map-transform.js). Anything that has to
// stand exactly on a surface should snap its own y; a bot steering towards a waypoint
// does not need to. Mirrored from src/shared/map-transform.js at generation time, the
// way server/map-actors.js mirrors the actor table:
//
//   UU_TO_M = ${UU_TO_M}
//   OFFSET  = (${r2(OFFSET.x)}, ${r2(OFFSET.y)}, ${r2(OFFSET.z)})
//   scene   = (UU_TO_M*uu.x + OFFSET.x, UU_TO_M*uu.z + OFFSET.y, UU_TO_M*uu.y + OFFSET.z)
//
// COSTS are Epic's own path length for the edge (\`distance\`, in UU) times UU_TO_M, so a
// cost is in the same units as the coordinates. UT truncates that length to an INT, so
// a walk spec can read up to 1 UU (0.024 units) shorter than the straight line between
// its endpoints; ${flooredWalk} of the ${edges.length - edges.filter((e) => e.flags & R_SPECIAL).length} walk/jump edges did, and each was floored back up to it so
// the heuristic in aStar() stays admissible. R_SPECIAL edges are NOT floored: their
// \`distance\` is a flat nominal cost (a teleport is instantaneous, and the longest one
// here jumps 2882 UU for a stated 100), so aStar() drops to a zero heuristic — plain
// Dijkstra, still optimal — whenever it is allowed to use them.
//
// CONNECTIVITY, checked at generation time:
//   whole graph, every edge         ${compLine(allComponents)}
//   walkable only (no R_SPECIAL)    ${compLine(walkComponents)}
${
  walkComponents.length > 1
    ? `//
// That split is the map, not a bug: CTF-Face reaches its tower alcoves and its
// translocator pads through teleporters, and a teleporter traversal is an R_SPECIAL
// spec. This game has no teleporters and no translocator, so aStar() leaves R_SPECIAL
// edges out BY DEFAULT and the reachable world is the ${walkComponents[0].length}-node main component —
// which contains both flag bases and all ${SPAWNS.red.length + SPAWNS.blue.length} player starts, verified below. Pass
// { special: true } to get Epic's full, single-component graph back.
//
// The ${walkComponents.length - 1} pockets that fall off without R_SPECIAL:
${strayNodes.map((s) => `//   ${s}`).join("\n")}`
    : "//\n// The walkable subgraph is fully connected on its own."
}
//
// SANITY, asserted by the generator before this file is written: every FlagBase and
// every PlayerStart in src/shared/map-actors.js has a nav node within ${OBJECTIVE_NODE_TOLERANCE} scene units
// (worst: ${worst.toFixed(2)}), and that node is in the main walkable component.

// The UE1 reachFlags bitfield, verbatim. \`flags\` on every edge is one of these ORed.
const REACH_FLAGS = { WALK: 1, FLY: 2, SWIM: 4, JUMP: 8, DOOR: 16, SPECIAL: 32, PLAYER_ONLY: 64 };

// id is the index into this array, so NODES[i].id === i.
const NODES = [
${nodes.map((n) => `  ${j(n)},`).join("\n")}
];

// Directed. \`cost\` is Epic's path length in scene units.
const EDGES = [
${edges.map((e) => `  ${j(e)},`).join("\n")}
];

// Out-edges per node, built once at require time rather than stored twice in the file.
const ADJACENCY = NODES.map(() => []);
for (const e of EDGES) ADJACENCY[e.from].push(e);

const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * The nav node closest to a point, by plain 3D distance.
 *
 * 3D and not 2D on purpose: CTF-Face stacks nodes vertically inside both towers, so a
 * ground-plane nearest would happily hand a bot on the floor a waypoint three storeys
 * up. ${nodes.length} nodes is small enough that the linear scan is not worth indexing.
 *
 * @param {number} x @param {number} y @param {number} z  scene units
 * @param {object} [opts]
 * @param {number} [opts.maxDist=Infinity]  give up beyond this and return null
 * @param {boolean} [opts.walkableOnly=true]  only consider the main walkable component
 * @param {(node) => boolean} [opts.filter]  extra predicate, e.g. n => n.cls === "DefensePoint"
 * @returns {object|null} the node, or null if nothing qualified
 */
function nearestNode(x, y, z, opts = {}) {
  const { maxDist = Infinity, walkableOnly = true, filter } = opts;
  const p = { x, y, z };
  let best = null;
  let bestD = maxDist;
  for (const n of NODES) {
    if (walkableOnly && !WALKABLE_MAIN.has(n.id)) continue;
    if (filter && !filter(n)) continue;
    const d = dist3(n, p);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/**
 * Shortest route through the graph, A* with a straight-line heuristic.
 *
 * @param {number} fromId @param {number} toId  node ids (indices into NODES)
 * @param {object} [opts]
 * @param {boolean} [opts.special=false]  allow R_SPECIAL edges (teleporters and
 *        translocator pads). Off by default: this game implements neither, so a route
 *        through one is a route the bot cannot actually take. Turning it on also turns
 *        the heuristic off — an R_SPECIAL edge carries a flat nominal cost far below the
 *        distance it covers, which would make a straight-line estimate inadmissible — so
 *        the search degrades to Dijkstra. Still optimal, just less directed.
 * @returns {number[]|null} node ids from fromId to toId inclusive, or null if unreachable
 */
function aStar(fromId, toId, opts = {}) {
  const allowSpecial = opts.special === true;
  if (!NODES[fromId] || !NODES[toId]) return null;
  if (fromId === toId) return [fromId];

  const goal = NODES[toId];
  const h = allowSpecial ? () => 0 : (n) => dist3(n, goal);
  const g = new Float64Array(NODES.length).fill(Infinity);
  const cameFrom = new Int32Array(NODES.length).fill(-1);
  const closed = new Uint8Array(NODES.length);
  g[fromId] = 0;

  // Binary min-heap of [f, nodeId]. Stale entries are skipped via \`closed\`.
  const heap = [[h(NODES[fromId]), fromId]];
  const push = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
        if (s === i) break;
        [heap[s], heap[i]] = [heap[i], heap[s]];
        i = s;
      }
    }
    return top;
  };

  while (heap.length) {
    const [, current] = pop();
    if (closed[current]) continue;
    if (current === toId) {
      const out = [current];
      for (let v = cameFrom[current]; v >= 0; v = cameFrom[v]) out.push(v);
      return out.reverse();
    }
    closed[current] = 1;
    for (const e of ADJACENCY[current]) {
      if (!allowSpecial && e.flags & REACH_FLAGS.SPECIAL) continue;
      if (closed[e.to]) continue;
      const tentative = g[current] + e.cost;
      if (tentative >= g[e.to]) continue;
      g[e.to] = tentative;
      cameFrom[e.to] = current;
      push([tentative + h(NODES[e.to]), e.to]);
    }
  }
  return null;
}

// The node ids reachable from each other without an R_SPECIAL edge — the part of the
// map a bot in this game can actually walk. Computed here rather than baked in as a
// list so it can never disagree with EDGES.
const WALKABLE_MAIN = (() => {
  const undirected = NODES.map(() => []);
  for (const e of EDGES) {
    if (e.flags & REACH_FLAGS.SPECIAL) continue;
    undirected[e.from].push(e.to);
    undirected[e.to].push(e.from);
  }
  const seen = new Int32Array(NODES.length).fill(-1);
  let best = [];
  for (let i = 0; i < NODES.length; i++) {
    if (seen[i] >= 0) continue;
    const group = [];
    const stack = [i];
    seen[i] = i;
    while (stack.length) {
      const v = stack.pop();
      group.push(v);
      for (const w of undirected[v]) {
        if (seen[w] < 0) {
          seen[w] = i;
          stack.push(w);
        }
      }
    }
    if (group.length > best.length) best = group;
  }
  return new Set(best);
})();

module.exports = { NODES, EDGES, ADJACENCY, REACH_FLAGS, WALKABLE_MAIN, nearestNode, aStar };
`;

const check2 = process.argv.includes("--check");
const current = fs.existsSync(OUT_CJS) ? fs.readFileSync(OUT_CJS, "utf8") : null;
if (current === text) {
  console.log(`  up to date  ${path.relative(ROOT, OUT_CJS)}`);
} else if (check2) {
  console.error(`  STALE       ${path.relative(ROOT, OUT_CJS)}`);
  console.error("\nRun `node scripts/gen-nav-graph.mjs` and commit the result.");
  process.exit(1);
} else {
  fs.writeFileSync(OUT_CJS, text);
  console.log(`  wrote       ${path.relative(ROOT, OUT_CJS)}`);
}

console.log(
  `\nedges: ${SYNTHESIZED ? "SYNTHESIZED BY PROXIMITY" : "Epic's ReachSpecs"}` +
    `\nnodes: ${nodes.length} (${classLine})` +
    `\nedges: ${edges.length} directed` +
    `\nwhole graph:      ${compLine(allComponents)}` +
    `\nwalkable subgraph: ${compLine(walkComponents)}` +
    `\nobjective check:  ${checks.length} FlagBases + PlayerStarts, worst nav-node distance ${worst.toFixed(2)} (tolerance ${OBJECTIVE_NODE_TOLERANCE})`
);
