// scene-lights.test.mjs — the lighting rig, pinned.
//
// index.html carried 19 `light=` attributes, five of which sat inside HTML comments
// (three dead ambients and two dead directionals) and one of which was a *mention* of
// `light="castShadow: true"` inside the #world comment. Fourteen were live, and those
// fourteen — hand-tuned against the CTF-Face reference over several sessions, with the
// reasoning written into the markup — are the ones scene/lights.js carries.
//
// This test exists so a later edit cannot quietly drop one: the count and the
// [type, intensity] table below are the tuned rig, not an implementation detail.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { LIGHTS, makeLight } from "../../src/game/scene/lights.js";

test("every live light from index.html is carried over — and no more", () => {
  assert.equal(LIGHTS.length, 14);
});

test("the tuned type/intensity table is unchanged, in markup order", () => {
  assert.deepEqual(
    LIGHTS.map((l) => [l.type, l.intensity]),
    [
      // Sky/ground bounce.
      ["hemisphere", 0.75],
      // #map-lights: flat fill, bridge fill, key light.
      ["ambient", 0.5],
      ["point", 15],
      ["directional", 3.1],
      // #blue-lights: interior spot, two tower exteriors, two crown lights.
      ["spot", 64.4],
      ["point", 122],
      ["point", 122],
      ["point", 39.3],
      ["point", 39.3],
      // #red-lights: same shape, warm.
      ["spot", 64.4],
      ["point", 86.4],
      ["point", 86.4],
      ["point", 29.5],
      ["point", 29.5],
    ]
  );
});

test("makeLight builds the right three class for every type in the rig", () => {
  const built = LIGHTS.map(makeLight);
  assert.ok(built[0].isHemisphereLight);
  assert.ok(built[1].isAmbientLight);
  assert.ok(built[2].isPointLight);
  assert.ok(built[3].isDirectionalLight);
  assert.ok(built[4].isSpotLight);
  for (const light of built) assert.ok(light instanceof THREE.Light);
});

test("the key light is the only shadow caster, at the markup's 2048 frustum", () => {
  const casters = LIGHTS.filter((l) => l.castShadow);
  assert.equal(casters.length, 1);
  const key = makeLight(casters[0]);
  assert.equal(key.name, "key-light");
  assert.equal(key.castShadow, true);
  assert.equal(key.shadow.mapSize.width, 2048);
  assert.equal(key.shadow.mapSize.height, 2048);
  assert.equal(key.shadow.camera.left, -165);
  assert.equal(key.shadow.camera.right, 165);
  assert.equal(key.shadow.camera.far, 935);
  assert.equal(key.shadow.bias, -0.0007);
  assert.equal(key.shadow.radius, 2);
});

test("point lights keep A-Frame's decay default of 1, not three's 2", () => {
  // ctf-flag.js and weapon-pickup.js build their glow lights with no decay at all and
  // their comments do the 1/d arithmetic explicitly; makeLight has to agree with them.
  const glow = makeLight({ type: "point", color: "#4aa8ff", intensity: 5.14, distance: 18.68 });
  assert.equal(glow.decay, 1);
  assert.equal(glow.distance, 18.68);
});

test("A-Frame's translateY(-1) CANCELS three's default up, leaving no offset at all", () => {
  // A-Frame's light component does `el.getObject3D('light').translateY(-1)` for spot,
  // directional and hemisphere lights (its HACK for issue #1624). three constructs those
  // three classes at Object3D.DEFAULT_UP — local (0,1,0) — so the translate puts them
  // back on the entity origin rather than a unit below the markup's `position`.
  assert.deepEqual(new THREE.HemisphereLight().position.toArray(), [0, 1, 0]);
  assert.deepEqual(new THREE.DirectionalLight().position.toArray(), [0, 1, 0]);
  assert.deepEqual(new THREE.SpotLight().position.toArray(), [0, 1, 0]);
  // PointLight starts at the origin, which is why A-Frame never translated it.
  assert.deepEqual(new THREE.PointLight().position.toArray(), [0, 0, 0]);

  const hemi = makeLight(LIGHTS[0]);
  assert.deepEqual(hemi.position.toArray(), [9.14829, 14.08152, 0]);
  const bridge = makeLight(LIGHTS[2]);
  assert.equal(bridge.position.y, 18.68);
});

test("the interior spots sit at the markup position and point straight down", () => {
  // The light is at the entity position (above), and the target is parented at the
  // entity-local (0,0,-1), which rotation="-90 0 0" turns into world (0,-1,0) from the
  // light. So the cone aims straight down — no 45-degree lean.
  const spot = makeLight(LIGHTS[4]);
  assert.deepEqual(spot.position.toArray(), [-91.14251, 13.44927, 1.07968]);
  const dir = new THREE.Vector3().subVectors(spot.target.position, spot.position).normalize();
  assert.ok(Math.abs(dir.x) < 1e-6);
  assert.ok(Math.abs(dir.y - -1) < 1e-6);
  assert.ok(Math.abs(dir.z) < 1e-6);
  assert.ok(Math.abs(spot.angle - THREE.MathUtils.degToRad(70)) < 1e-9);
  assert.equal(spot.penumbra, 0.6);
});

test("the key light aims at the world origin, as three's untouched target does", () => {
  const key = makeLight(LIGHTS[3]);
  assert.deepEqual(key.target.position.toArray(), [0, 0, 0]);
  assert.deepEqual(key.position.toArray(), [163.49, 221.87, -233.55]);
});

test("a perspective shadow caster gets A-Frame's shadowCameraFov default of 90", () => {
  // A-Frame's updateShadow() wrote shadowCameraFov (schema default 90) on every caster;
  // only the perspective shadow cameras — spot and point — have somewhere to put it.
  // Nothing in LIGHTS casts from a point light today, so this pins the branch directly.
  const point = makeLight({ type: "point", color: "#ffffff", intensity: 1, castShadow: true });
  assert.equal(point.castShadow, true);
  assert.equal(point.shadow.camera.isOrthographicCamera, undefined);
  assert.equal(point.shadow.camera.fov, 90);
});
