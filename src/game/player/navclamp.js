// navclamp.js — the player's navmesh constraint, on three-pathfinding directly.
//
// This is aframe-extras' `nav` system + `nav-mesh` + `movement-controls
// constrainToNavMesh`, with one deliberate change of behaviour.
//
// WHAT THE LIBRARY ACTUALLY DOES
// `Pathfinding.clampStep(start, end, node, zone, group, out)` never reads `start`. It
// takes the polygon you hand it as `node`, projects `end` onto that polygon's plane, and
// breadth-first searches the polygon and its neighbours (three hops) for the closest
// point to that projection. So the whole question of "where am I" is the caller's, and
// the caller is a two-line cache: which group, which polygon.
//
// WHAT AFRAME-EXTRAS DID WITH IT, AND WHY WE DON'T
// Its `nav` system asked `getClosestNode(pos, zone, group, /* checkPolygon */ true)`,
// which returns null unless the point is inside a polygon AND within half a metre of its
// height. When that returned null it skipped the clamp altogether — `out.copy(end)`, the
// rig unconstrained for that frame — and tried to re-acquire at the *end* point. Lift the
// rig off the surface and you get a mixture of unclamped frames and clamps against
// whatever polygon happened to be re-acquired, which is the measured slingshot recorded
// in ut-movement.js under "WHY THE HOP IS NOT ON THE RIG" (1.5 m of lift turned 9.4 m/s
// into peaks of 43 m/s).
//
// We re-acquire instead: if the strict lookup fails we fall back to the nearest polygon
// by centroid, so there is always a node and the rig is always clamped. That is what lets
// the hop live on the rig's CHILDREN and the rig itself stay on the polygon — see
// player/controller.js. The rig's y is still the navmesh y, which is what the wire
// protocol and the server expect; nothing about that changes.
//
// The clamp keeps its own group/node cache and must be told when the player teleports
// (respawn): `reset()`. Without it the next step is searched from the polygon we were
// standing on before the teleport, three hops away at most, and the player is dragged
// back across the map.
import * as THREE from "three";
import { Pathfinding } from "../vendor/three-pathfinding.module.js";

const ZONE = "level";

/**
 * @param {THREE.BufferGeometry} geometry one triangle soup in world coordinates —
 *   `mergeNavmesh(game.navmesh)` produces it from the navmesh glTF.
 * @param {string} [zone] the zone key; only one is ever used, the name is the library's.
 */
export function createNavClamp(geometry, zone = ZONE) {
  const pf = new Pathfinding();
  pf.setZoneData(zone, Pathfinding.createZone(geometry));
  const zoneData = pf.zones[zone];

  // The cache. `group` is a connected component of the mesh, `node` a polygon in it.
  let group = null;
  let node = null;

  // clampStep writes through `.copy()`, so its output has to be a real Vector3 even when
  // the caller hands us a plain {x, y, z}.
  const scratch = new THREE.Vector3();
  const plane = new THREE.Plane();

  /** The strict lookup aframe-extras used, then the one that always answers. */
  function closestNode(position, g) {
    return pf.getClosestNode(position, zone, g, true) || pf.getClosestNode(position, zone, g, false);
  }

  function acquire(position) {
    if (group === null) group = pf.getGroup(zone, position, true);
    if (group === null) return null; // no navmesh within 50 units: nothing to clamp to
    if (!node) node = closestNode(position, group);
    return node;
  }

  return {
    /**
     * One frame of movement, clamped. `from` is where the rig is, `to` where it wants to
     * be; `out` receives where it may go and is returned. `out` may alias `from`.
     */
    step(from, to, out) {
      const start = acquire(from);
      if (!start) {
        // Off the map entirely (an empty or missing navmesh). Move freely and try to
        // pick the surface up again next frame, as the old system did.
        out.x = to.x;
        out.y = to.y;
        out.z = to.z;
        return out;
      }
      node = pf.clampStep(from, to, start, zone, group, scratch) || node;
      out.x = scratch.x;
      out.y = scratch.y;
      out.z = scratch.z;
      return out;
    },

    /**
     * The walkable height at a point: the closest polygon's plane, solved for y at the
     * point's x/z. Returns null when there is no polygon nearby.
     *
     * CTF-Face is stacked — tower floors sit directly above the terrain — so pass the y
     * you are near if you have one (`heightAt(rig.position)`). With no y the search runs
     * against y = 0, and near a tower that answers about whichever storey is closest to
     * sea level rather than the one you are on.
     *
     * Does not touch the walking cache: this is a query, not a step.
     */
    heightAt(point) {
      const probe = {
        x: point.x,
        y: Number.isFinite(point.y) ? point.y : 0,
        z: point.z,
      };
      const g = pf.getGroup(zone, probe, true);
      if (g === null) return null;
      const n = closestNode(probe, g);
      if (!n) return null;
      const [a, b, c] = n.vertexIds;
      plane.setFromCoplanarPoints(zoneData.vertices[a], zoneData.vertices[b], zoneData.vertices[c]);
      const { x: nx, y: ny, z: nz } = plane.normal;
      // A polygon standing on its edge has no single height; the centroid is the only
      // honest answer left. The navmesh has no such polygons, but a bad export would.
      if (Math.abs(ny) < 1e-6) return n.centroid.y;
      return -(plane.constant + nx * probe.x + nz * probe.z) / ny;
    },

    /** Call on every teleport (respawn). See the header. */
    reset() {
      group = null;
      node = null;
    },

    /** For probes and debugging: the zone the clamp was built from. */
    get zoneData() {
      return zoneData;
    },
  };
}

/**
 * The navmesh glTF is several meshes, each with its own transform, and `createZone` takes
 * exactly one geometry in one coordinate system. Flatten `root` into that: every mesh
 * de-indexed, baked into world space, stripped to positions.
 *
 * Non-indexed on purpose — `createZone` runs its own `mergeVertices` and re-indexes with
 * its own tolerance regardless of what it is given, so an index here would be built and
 * thrown away. Stripped to positions because a navmesh's normals and UVs are dead weight
 * and, more usefully, because the meshes need not share an attribute set to be merged.
 *
 * @param {THREE.Object3D} root
 * @returns {THREE.BufferGeometry}
 */
export function mergeNavmesh(root) {
  root.updateMatrixWorld(true);

  // Read through the attribute accessors rather than the backing array: a glTF mesh can
  // arrive interleaved or quantised, and this runs once at load.
  const verts = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.getAttribute("position")) return;
    const src = o.geometry;
    const g = src.index ? src.toNonIndexed() : src.clone();
    for (const name of Object.keys(g.attributes)) {
      if (name !== "position") g.deleteAttribute(name);
    }
    g.morphAttributes = {};
    // After the strip, so nothing but positions is transformed.
    g.applyMatrix4(o.matrixWorld);
    const p = g.getAttribute("position");
    for (let i = 0; i < p.count; i++) verts.push(p.getX(i), p.getY(i), p.getZ(i));
    g.dispose();
  });

  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts), 3));
  return merged;
}
