// viewmodels.test.mjs — that the first-person weapons are placeable.
//
// These run on the committed weapon table, with no retail install, because the point is
// to catch the extraction having gone wrong AFTER it was extracted — the failure mode
// where a mesh is displaced or turned and the numbers still look like numbers.
//
// The bug this exists for: WarHead carries a Mesh.Origin of (0, -210, -50), and applying
// it — which is right for a mesh hung on an actor in the world — moved the Redeemer's
// whole view model about 5 metres from the camera. Nothing threw. The geometry was
// valid, the textures were fine, the barrel tip was computed correctly. It was just
// computed for a weapon floating in the middle distance.
import test from "node:test";
import assert from "node:assert/strict";
// The SHARED table, not server/weapons.js: view models are a client-rendering concern
// and the server's twin deliberately carries only what the server reasons about.
import { WEAPONS } from "../../src/shared/weapons.js";

test("every weapon has a first-person view model", () => {
  for (const [id, w] of Object.entries(WEAPONS)) {
    assert.ok(w.view, `${id} has no view model`);
    assert.match(w.view.model, /^assets\/3d\/viewmodels\/.+\.gltf$/, `${id} model path`);
    assert.equal(w.view.rotationDeg.length, 3, `${id} rotation`);
    assert.equal(w.view.muzzleLocal.length, 3, `${id} muzzle`);
  }
});

test("the muzzle is inside the weapon it belongs to", () => {
  // A barrel tip is a point ON the mesh, so it cannot be outside the mesh's own box.
  // The tolerance is a hair for float rounding, not room for a wrong answer.
  const EPS = 1e-3;
  for (const [id, w] of Object.entries(WEAPONS)) {
    const { min, max } = w.view.bboxM;
    w.view.muzzleLocal.forEach((v, a) => {
      assert.ok(
        v >= min[a] - EPS && v <= max[a] + EPS,
        `${id}: muzzle axis ${"xyz"[a]} is ${v}, outside the mesh's ${min[a]}..${max[a]}`,
      );
    });
  }
});

test("no view model is displaced from its own origin", () => {
  // The Redeemer's failure was not that the muzzle left the box — the box moved with it.
  // A first-person weapon is drawn a few centimetres from the eye, so a mesh whose box
  // sits metres away is displaced whatever its internal consistency says.
  for (const [id, w] of Object.entries(WEAPONS)) {
    const { min, max } = w.view.bboxM;
    for (let a = 0; a < 3; a++) {
      const nearest = Math.min(Math.abs(min[a]), Math.abs(max[a]));
      assert.ok(
        nearest < 1,
        `${id}: the mesh's ${"xyz"[a]} runs ${min[a]}..${max[a]}, ` +
          `never coming within a metre of its own origin — it is displaced, not just large`,
      );
    }
  }
});

test("weapons are the size of weapons", () => {
  // Held guns, in metres, before the one fitted display scale in first-person-weapon.js.
  // Wide bounds on purpose: this is here to catch a scale that is out by an order of
  // magnitude — a missing Mesh.Scale, or PlayerViewScale read as 0 — not to pin a value.
  for (const [id, w] of Object.entries(WEAPONS)) {
    const longest = Math.max(...w.view.sizeM);
    assert.ok(longest > 0.02, `${id} is only ${longest} m long — a scale is missing`);
    assert.ok(longest < 2, `${id} is ${longest} m long — a scale is applied twice`);
  }
});

test("the Rocket Launcher turns the opposite way to the rifles", () => {
  // Not a style point. The old code applied one hardcoded "0 90 0" to all six, and
  // UT_Eightball's RotOrigin is -90: it was mounted backwards and nothing said so.
  // This pins the asymmetry so a future "tidy-up" cannot quietly restore it.
  assert.equal(WEAPONS.rocket.view.rotationDeg[1], -90);
  for (const id of ["sniper", "shock", "ripper", "enforcer"]) {
    assert.equal(WEAPONS[id].view.rotationDeg[1], 90, `${id} yaw`);
  }
});

test("the Redeemer turns on all three axes", () => {
  // The other half of what one constant could not express. WarHead's RotOrigin is a full
  // rotator, and it is also the one weapon that proves the UE1 -> scene axis mapping is
  // right: pitch and roll land on scene Z and X, not the other way round, and swapping
  // them is invisible on every weapon whose pitch and roll are zero.
  const r = WEAPONS.redeemer.view.rotationDeg;
  assert.notEqual(r[0], 0, "roll -> scene x");
  assert.equal(r[1], 90, "yaw -> scene y");
  assert.notEqual(r[2], 0, "pitch -> scene z");
});
