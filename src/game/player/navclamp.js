// navclamp.js — the player's navmesh constraint, on three-pathfinding directly.
//
// This is aframe-extras' `nav` system + `nav-mesh` + `movement-controls
// constrainToNavMesh`, with two deliberate changes of behaviour.
//
// WHAT THE LIBRARY ACTUALLY DOES
// `Pathfinding.clampStep(start, end, node, zone, group, out)` never reads `start`. It
// takes the polygon you hand it as `node`, projects `end` onto that polygon's plane, and
// breadth-first searches the polygon and its neighbours (three hops) for the closest
// point to that projection. So the whole question of "where am I" is the caller's, and
// the caller is a two-line cache: which group, which polygon.
//
// WHAT A-FRAME EXTRAS DID WITH IT, AND WHY WE DON'T (1): NEVER UNCLAMPED
// Its `nav` system asked `getClosestNode(pos, zone, group, /* checkPolygon */ true)`,
// which returns null unless the point is inside a polygon AND within half a metre of its
// height. When that returned null it skipped the clamp altogether — `out.copy(end)`, the
// rig unconstrained for that frame — and tried to re-acquire at the *end* point. Lift the
// rig off the surface and you get a mixture of unclamped frames and clamps against
// whatever polygon happened to be re-acquired, which is the measured slingshot recorded
// in ut-movement.js under "WHY THE HOP IS NOT ON THE RIG" (1.5 m of lift turned 9.4 m/s
// into peaks of 43 m/s). We fall back to the nearest polygon by centroid instead, so
// there is always a node and the rig is always clamped. That is what lets the hop live on
// the rig's CHILDREN and the rig itself stay on the polygon — see player/controller.js.
// The rig's y is still the navmesh y, which is what the wire and the server expect.
//
// WHAT A-FRAME EXTRAS DID WITH IT, AND WHY WE DON'T (2): NEVER IMPRISONED
// CTF-Face's navmesh is 791 polygons in 41 disconnected GROUPS, and clampStep can only
// ever return a polygon from the group it was handed. Six of the ten blue PlayerStarts
// (and the blue flag home) are on small islands — group 1 is 11 polygons, 16.3 x 5.1 m,
// separated from the 474-polygon main mesh by a real hole about a metre across. Cache the
// group once, as the old code did, and a player spawning there can never leave: measured
// live, walking east from PlayerStart7 stopped dead at x = -69.40 and stayed there.
//
// The old code got out of that by accident — the unclamped frame above was also an escape
// hatch. We do it on purpose instead, and on a leash. When a step is BLOCKED (the rig
// asked to move and barely moved) we look the group up again ahead of the rig and adopt
// it, subject to all of:
//
//   - the probe point is INSIDE a polygon: `getClosestNode(p, …, checkPolygon: true)`,
//     which also means within half a metre of that polygon's own height. This is the
//     whole safety argument. `getGroup` falls back to "nearest centroid" and will happily
//     name a group on the far side of a wall, so adopting on `getGroup` alone would fling
//     a player who walks into geometry across the map.
//   - probes past the step's own destination (`to`) may only adopt a DIFFERENT group.
//     Inside one connected component a blocked step means a wall or a ledge, and walls
//     stay walls; only the seams BETWEEN components are bridged.
//   - nothing further ahead than `bridgeGap` (default 1.5 m). Measured on this map: the
//     hole between the blue base island and the main mesh is 1.24 m at the point the rig
//     jams against, so `to` alone — 0.15 m of intent at a walking pace — never reaches
//     across it, and a probe that stops at the destination leaves the player imprisoned.
//   - at most RETRY_HZ times a second, because each probe is a full scan of the zone
//     (~21 us) where an ordinary step is ~1 us.
//
// That is a strictly smaller hole in the constraint than the one it replaces: today's
// code lets the rig move ANYWHERE for the blocked frame; this moves it at most 1.5 m, and
// only onto real floor at its own height.
//
// COST, MEASURED IN THE BROWSER ON THE REAL NAVMESH (791 polygons, 41 groups)
//   step()      ~1.0 us     — call it every frame
//   heightAt()  ~21.5 us    — ~20x a step; at most one call per frame, and pass the
//                             rig's own y (see heightAt).
//
// The clamp keeps its own group/node cache and must be told when the player teleports
// (respawn): `reset()`. Without it the next step is searched from the polygon we were
// standing on before the teleport, three hops away at most, and the player is dragged
// back across the map.
import * as THREE from "three";
import { Pathfinding } from "../vendor/three-pathfinding.module.js";

const ZONE = "level";

// A step that asked for at least this much horizontal movement (metres)...
const BLOCKED_MIN_REQUEST = 0.05;
// ...and got less than this fraction of it is "blocked" and triggers a re-acquisition.
const BLOCKED_FRACTION = 0.1;
// How often that re-acquisition may run. Four times a second is invisible to the player
// (a quarter second stuck against a wall they were already stuck against) and keeps the
// scan off the frame budget.
const RETRY_HZ = 4;
const RETRY_INTERVAL_MS = 1000 / RETRY_HZ;
// How far past the step's destination a blocked step may look for another group, and how
// finely. 1.5 m clears this map's worst navmesh seam (1.24 m) and is under the 1.9 m the
// UT99 pawn is tall, so it can never read as teleporting.
const DEFAULT_BRIDGE_GAP = 1.5;
const BRIDGE_PROBE_STEP = 0.25;

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// heightAt's probe point, hoisted: it is a query on the hot path and allocates nothing.
const probe = { x: 0, y: 0, z: 0 };

/**
 * @param {THREE.BufferGeometry} geometry one triangle soup in world coordinates —
 *   `mergeNavmesh(game.navmesh)` produces it from the navmesh glTF.
 * @param {object} [options]
 * @param {string} [options.zone] the zone key; only one is ever used, the name is the
 *   library's.
 * @param {number} [options.bridgeGap] metres a blocked step may look past its own
 *   destination for another group. 0 disables seam-bridging entirely; see the header.
 */
export function createNavClamp(geometry, { zone = ZONE, bridgeGap = DEFAULT_BRIDGE_GAP } = {}) {
  const pf = new Pathfinding();
  pf.setZoneData(zone, Pathfinding.createZone(geometry));
  const zoneData = pf.zones[zone];

  // The cache. `group` is a connected component of the mesh, `node` a polygon in it.
  let group = null;
  let node = null;
  let lastRetryAt = -Infinity;

  // clampStep writes through `.copy()`, so its output has to be a real Vector3 even when
  // the caller hands us a plain {x, y, z}.
  const scratch = new THREE.Vector3();
  const plane = new THREE.Plane();
  const tri = new THREE.Triangle();
  const near = new THREE.Vector3();
  const bridge = { x: 0, y: 0, z: 0 };

  /**
   * Which group is this point in? `checkPolygon: true`, where aframe-extras passed false.
   *
   * The flag only adds a short-circuit: if the point is within 1 cm of a polygon's plane
   * AND inside that polygon, return its group immediately. CTF-Face is stacked — tower
   * floors sit 70 m above the terrain they overlap in x/z — so standing on a floor should
   * name that floor's group, not whichever centroid happens to be nearest in 3D. When the
   * point is NOT on a surface (a rig mid-hop, a probe with no y) the short-circuit cannot
   * fire and this degenerates to exactly the nearest-centroid search aframe-extras did.
   */
  function groupAt(position) {
    return pf.getGroup(zone, position, true);
  }

  /** The strict lookup aframe-extras used, then the one that always answers. */
  function closestNode(position, g) {
    return pf.getClosestNode(position, zone, g, true) || pf.getClosestNode(position, zone, g, false);
  }

  function acquire(position) {
    if (group === null) group = groupAt(position);
    if (group === null) return null; // no navmesh within 50 m: nothing to clamp to
    if (!node) node = closestNode(position, group);
    return node;
  }

  /** Distance from `point` to the closest point on polygon `n`'s triangle. */
  function distanceToPolygon(point, n) {
    const [a, b, c] = n.vertexIds;
    tri.set(zoneData.vertices[a], zoneData.vertices[b], zoneData.vertices[c]);
    tri.closestPointToPoint(point, near);
    return near.distanceTo(point);
  }

  /**
   * Look for a polygon to jump to, ahead of a blocked step. First the destination itself
   * — always safe, it is exactly where the player asked to stand — then, if `bridgeGap`
   * allows, a few points further along the same heading, which may only land in a group
   * we are not already in. Returns {group, node} or null. See the header for the rules.
   */
  function reacquire(from, to, requested) {
    const dx = (to.x - from.x) / requested;
    const dz = (to.z - from.z) / requested;
    for (let ahead = 0; ahead <= bridgeGap + 1e-9; ahead += BRIDGE_PROBE_STEP) {
      bridge.x = to.x + dx * ahead;
      bridge.y = to.y;
      bridge.z = to.z + dz * ahead;
      const g = groupAt(bridge);
      // Past the destination we bridge seams between components, never walls inside one.
      if (g === null || (ahead > 0 && g === group)) continue;
      // checkPolygon: true, and no fallback. The probe has to be standing on REAL floor
      // at its own height before we adopt it.
      const node = pf.getClosestNode(bridge, zone, g, true);
      if (node) return { group: g, node };
    }
    return null;
  }

  return {
    /**
     * One frame of movement, clamped. `from` is where the rig is, `to` where it wants to
     * be; `out` receives where it may go and is returned.
     *
     * `out` MAY ALIAS `from` (the controller passes `rig.position` for both). That is safe
     * because clampStep never reads its `start` argument, and because the group/node
     * acquisition — the only other reader of `from` — completes before anything is
     * written. The blocked-step test below reads `from` through locals captured up front
     * for the same reason.
     *
     * @param {{x:number,y:number,z:number}} from
     * @param {{x:number,y:number,z:number}} to
     * @param {{x:number,y:number,z:number}} out mutated and returned
     * @param {number} [now] milliseconds, for the retry rate limit; defaults to
     *   performance.now(). Pass the frame's own `now` so every clamp in a frame agrees.
     */
    step(from, to, out, now = nowMs()) {
      const fromX = from.x;
      const fromZ = from.z;

      const start = acquire(from);
      if (!start) {
        // Off the map entirely (an empty or missing navmesh). Move freely and try to
        // pick the surface up again next frame, as the old system did.
        out.x = to.x;
        out.y = to.y;
        out.z = to.z;
        return out;
      }

      let landed = pf.clampStep(from, to, start, zone, group, scratch);
      // clampStep's BFS always visits the node it was handed, so it always names one —
      // but if a future version ever returns nothing, `scratch` is untouched and holds a
      // stale point. Leave `out` exactly as the caller passed it rather than lie.
      if (!landed) return out;

      // BLOCKED? See the header. Only the horizontal move counts: the y is the floor's,
      // not the player's intent.
      const requested = Math.hypot(to.x - fromX, to.z - fromZ);
      if (requested >= BLOCKED_MIN_REQUEST) {
        const moved = Math.hypot(scratch.x - fromX, scratch.z - fromZ);
        if (moved < requested * BLOCKED_FRACTION && now - lastRetryAt >= RETRY_INTERVAL_MS) {
          lastRetryAt = now;
          const adopted = reacquire(from, to, requested);
          if (adopted) {
            group = adopted.group;
            const again = pf.clampStep(from, to, adopted.node, zone, group, scratch);
            landed = again || adopted.node;
          }
        }
      }

      node = landed;
      out.x = scratch.x;
      out.y = scratch.y;
      out.z = scratch.z;
      return out;
    },

    /**
     * The walkable surface under a point: `{ y, dist }`, where `y` is the closest
     * polygon's plane solved for the point's x/z and `dist` is how far the point actually
     * is from that polygon. Returns null when the zone has nothing within
     * three-pathfinding's 50 m search radius, or beyond `maxDist` if you pass one.
     *
     * A NON-NULL RESULT IS NOT "THERE IS FLOOR HERE". The search always answers if
     * anything at all is within 50 m, so `dist` is the part that tells you whether the
     * answer means anything — check it, or pass `maxDist`.
     *
     * PASS THE Y YOU ARE NEAR. CTF-Face is stacked: with no y the search runs against
     * y = 0, so asking about the blue tower roof (y ~ 71) answers with the terrain 71 m
     * below it. `heightAt(rig.position)` is almost always what you want.
     *
     * ~23.8 us against the real navmesh, ~17x a step. One call per frame, not several.
     * Does not touch the walking cache: this is a query, not a step.
     *
     * @param {{x:number,y?:number,z:number}} point
     * @param {number} [maxDist] metres; beyond this the answer is null instead
     * @returns {{y:number,dist:number}|null}
     */
    heightAt(point, maxDist = Infinity) {
      probe.x = point.x;
      probe.y = Number.isFinite(point.y) ? point.y : 0;
      probe.z = point.z;

      const g = groupAt(probe);
      if (g === null) return null;
      const n = closestNode(probe, g);
      if (!n) return null;

      const dist = distanceToPolygon(probe, n);
      if (dist > maxDist) return null;

      const [a, b, c] = n.vertexIds;
      plane.setFromCoplanarPoints(zoneData.vertices[a], zoneData.vertices[b], zoneData.vertices[c]);
      const { x: nx, y: ny, z: nz } = plane.normal;
      // A polygon standing on its edge has no single height; the centroid is the only
      // honest answer left. The navmesh has no such polygons, but a bad export would.
      if (Math.abs(ny) < 1e-6) return { y: n.centroid.y, dist };
      return { y: -(plane.constant + nx * probe.x + nz * probe.z) / ny, dist };
    },

    /** Call on every teleport (respawn). See the header. */
    reset() {
      group = null;
      node = null;
      lastRetryAt = -Infinity;
    },

    /** For probes and debugging: the zone the clamp was built from. */
    get zoneData() {
      return zoneData;
    },
  };
}

/**
 * Flatten a navmesh glTF into the single world-space triangle soup `createZone` wants:
 * every mesh de-indexed, de-quantised and baked into world coordinates, positions only.
 *
 * TODAY THAT IS ONE MESH. `assets/.../navmesh.glb` is a single mesh with a single
 * primitive on an identity node, and aframe-extras' `nav-mesh` component relied on that —
 * it took the LAST mesh in the traverse and ignored any others. This walks all of them so
 * that a re-export which splits the mesh (or parents it under a transform) is a non-event
 * rather than a silent loss of half the floor.
 *
 * Non-indexed on purpose: `createZone` runs its own `mergeVertices` and re-indexes with
 * its own tolerance regardless of what it is given, so an index here would be built and
 * thrown away. The concatenation is hand-rolled because the repo's copy of
 * `src/ar/vendor/utils/BufferGeometryUtils.js` is a deliberately minimal slice for
 * GLTFLoader — its only export is `toTrianglesDrawMode`, there is no `mergeGeometries`.
 *
 * @param {THREE.Object3D} root
 * @returns {THREE.BufferGeometry}
 */
export function mergeNavmesh(root) {
  // Ancestors first, then descendants: `root` is a child of the navmesh node, which is a
  // child of the world group, and nothing has necessarily been rendered yet. This is what
  // aframe-extras' nav-mesh did (`updateWorldMatrix(true, false)`) before applying it.
  root.updateWorldMatrix(true, true);

  const verts = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const src = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
    const p = src.getAttribute("position");
    if (p) {
      // Read each vertex out through the accessors and transform the COPY. getX/getY/getZ
      // de-quantise a normalised attribute and see through an interleaved buffer;
      // BufferGeometry.applyMatrix4 writes back through the same accessors, and a
      // normalised Int16 position cannot hold a world coordinate. So never transform in
      // place — read out first, as here.
      for (let i = 0; i < p.count; i++) {
        v.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(o.matrixWorld);
        verts.push(v.x, v.y, v.z);
      }
    }
    if (src !== o.geometry) src.dispose(); // toNonIndexed() made a copy; drop it
  });

  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts), 3));
  return merged;
}
