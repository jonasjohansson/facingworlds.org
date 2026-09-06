// navclamp.test.mjs — the navmesh clamp that replaces aframe-extras.
//
// `movement-controls constrainToNavMesh` + `nav-mesh` were a thin wrapper around
// three-pathfinding's `clampStep`, and leaving A-Frame means owning that wrapper. The
// wrapper is the whole point: `clampStep` itself is stateless about where you ARE — it
// projects the *end* of the step onto the plane of the polygon you hand it and then
// breadth-first searches that polygon's neighbours (depth 3) for the closest reachable
// point. Everything that made the old rig behave — which polygon we think we are on, and
// what happens when that answer is lost — lives in the caller. aframe-extras' caller
// asked for the containing polygon with `checkPolygon: true`, got `null` the moment the
// rig left the surface, and then skipped the clamp entirely (`out.copy(end)`), which is
// exactly why the jump had to be moved off the rig (ut-movement.js, "WHY THE HOP IS NOT
// ON THE RIG"). Ours re-acquires instead, so the rig is never unclamped.
//
// These tests pin the four behaviours the player controller depends on.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createNavClamp, mergeNavmesh } from "../../src/game/player/navclamp.js";

// `Pathfinding.createZone` runs its input through its own `mergeVertices`, which accepts
// indexed OR non-indexed geometry and always hands back an indexed one — so a stock
// PlaneGeometry (indexed) is fine, and so is the non-indexed geometry mergeNavmesh
// builds. What it does NOT accept is anything but triangles: it walks `index.count` in
// threes. It also rounds every zone vertex to two decimals (`Utils.roundNumber(v, 2)`),
// which is why the height assertions below are to the centimetre and not tighter.
function flatGrid(size, segments) {
  const g = new THREE.PlaneGeometry(size, size, segments, segments);
  g.rotateX(-Math.PI / 2); // XY quad -> XZ floor at y = 0
  g.translate(size / 2, 0, size / 2); // x, z in [0, size]
  return g;
}

const v3 = () => new THREE.Vector3();

test("a step off the edge is clamped to the mesh and lands on the polygon's y", () => {
  const clamp = createNavClamp(flatGrid(10, 4));
  // 10 m of intent into 10 m of floor, from the middle: the target is 5 m past the edge.
  const out = clamp.step({ x: 5, y: 0, z: 5 }, { x: 5, y: 0, z: 15 }, v3());
  assert.ok(out.z <= 10 + 1e-6, `clamped to the edge, got z=${out.z}`);
  assert.ok(out.z > 5, `moved forward, got z=${out.z}`);
  assert.ok(Math.abs(out.y) < 1e-6, `stayed on the floor, got y=${out.y}`);
  // The API contract the controller relies on: `out` is returned, and plain
  // {x, y, z} objects are accepted on the way in (rig.position is a Vector3, but the
  // spawn probe and the tests are not).
  const plain = clamp.step({ x: 5, y: 0, z: 5 }, { x: 15, y: 0, z: 5 }, { x: 0, y: 0, z: 0 });
  assert.ok(plain.x <= 10 + 1e-6 && plain.x > 5);
});

test("a start off the mesh is snapped to the closest node, not dropped", () => {
  // Both cases return `null` from getClosestNode(..., checkPolygon: true) — the y test
  // fails when you are lifted, the point-in-polygon test fails when you are outside —
  // and that null is what unclamped the old rig mid-jump.
  for (const start of [
    { x: 5, y: 3, z: 5 }, // 3 m above the floor: a jump
    { x: -2, y: 0, z: 5 }, // 2 m outside the west edge: pushed off by a collision
  ]) {
    const clamp = createNavClamp(flatGrid(10, 4));
    const out = clamp.step(start, { x: start.x, y: start.y, z: start.z + 1 }, v3());
    assert.ok(Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z), `finite from ${JSON.stringify(start)}`);
    assert.ok(out.x >= -1e-6 && out.x <= 10 + 1e-6, `on the mesh in x, got ${out.x}`);
    assert.ok(out.z >= -1e-6 && out.z <= 10 + 1e-6, `on the mesh in z, got ${out.z}`);
    assert.ok(Math.abs(out.y) < 1e-6, `pulled back down to the floor, got y=${out.y}`);
  }
});

test("heightAt reads the polygon's plane, and gives up rather than guess", () => {
  const flat = createNavClamp(flatGrid(10, 4));
  assert.ok(Math.abs(flat.heightAt({ x: 5, z: 5 })) < 1e-6);

  // A floor tipped 10 degrees about x: a point at world z lies at y = -z * tan(10deg).
  const sloped = flatGrid(10, 4);
  sloped.rotateX(THREE.MathUtils.degToRad(10));
  const clamp = createNavClamp(sloped);
  for (const z of [2.5, 5, 7.5]) {
    const expected = -z * Math.tan(THREE.MathUtils.degToRad(10));
    const got = clamp.heightAt({ x: 5, z });
    // Not 1e-3: zone vertices are rounded to two decimals (see the note on flatGrid),
    // and a plane fitted through three of them is out by up to ~4 mm here. The rig's y
    // has always been quantised to the centimetre by this; nothing regressed.
    assert.ok(Math.abs(got - expected) < 5e-3, `z=${z}: got ${got}, expected ${expected}`);
  }

  // Off the end of the world: three-pathfinding's getGroup gives up past 50 units.
  assert.equal(clamp.heightAt({ x: 1000, z: 1000 }), null);
});

test("reset() forgets the cached polygon, so a respawn does not walk from the old one", () => {
  const clamp = createNavClamp(flatGrid(40, 16));
  const near = { x: 5, y: 0, z: 5 };
  const far = { x: 35, y: 0, z: 35 };
  const out = v3();

  clamp.step(near, { x: near.x, y: 0, z: near.z + 0.15 }, out); // caches the polygon at (5, 5)

  // Teleported without telling the clamp: clampStep only ever searches three polygons
  // out from the one it was handed, so the result is stuck back at the old corner.
  clamp.step(far, { x: far.x, y: 0, z: far.z + 0.15 }, out);
  assert.ok(Math.hypot(out.x - far.x, out.z - far.z) > 10, `stale node drags the step home, got (${out.x}, ${out.z})`);

  clamp.reset();
  clamp.step(far, { x: far.x, y: 0, z: far.z + 0.15 }, out);
  assert.ok(Math.hypot(out.x - far.x, out.z - far.z) < 1, `re-acquired at the new spot, got (${out.x}, ${out.z})`);
});

test("mergeNavmesh bakes world transforms into one geometry", () => {
  // The navmesh .glb is several meshes, each with its own transform, and createZone
  // takes exactly one geometry in one coordinate system.
  const root = new THREE.Group();
  const a = new THREE.Mesh(flatGrid(10, 2));
  const b = new THREE.Mesh(flatGrid(10, 2));
  b.position.set(20, 3, 0);
  root.add(a, b);
  root.position.set(100, 0, 0); // a parent transform has to come through too

  const merged = mergeNavmesh(root);
  assert.equal(merged.index, null, "non-indexed: createZone re-indexes anyway");
  assert.deepEqual(Object.keys(merged.attributes), ["position"]);
  merged.computeBoundingBox();
  const { min, max } = merged.boundingBox;
  assert.ok(Math.abs(min.x - 100) < 1e-4 && Math.abs(max.x - 130) < 1e-4, `x ${min.x}..${max.x}`);
  assert.ok(Math.abs(min.y - 0) < 1e-4 && Math.abs(max.y - 3) < 1e-4, `y ${min.y}..${max.y}`);
  assert.ok(Math.abs(min.z - 0) < 1e-4 && Math.abs(max.z - 10) < 1e-4, `z ${min.z}..${max.z}`);

  // And the result is something createZone will actually take.
  const clamp = createNavClamp(merged);
  assert.ok(Math.abs(clamp.heightAt({ x: 105, z: 5 })) < 1e-6);
});
