// viewmodels.test.mjs — that the first-person weapons are placeable, pointed the right
// way, and carry UT99's own animation.
//
// These run on the committed weapon table and the committed glTFs, with no retail
// install, because the point is to catch the extraction having gone wrong AFTER it was
// extracted — the failure mode where a mesh is displaced or turned and the numbers still
// look like numbers.
//
// The two bugs this exists for:
//
//   WarHead carries a Mesh.Origin of (0, -210, -50), and applying it — which is right for
//   a mesh hung on an actor in the world — moved the Redeemer's whole view model about 5
//   metres from the camera. Nothing threw. The geometry was valid, the textures were
//   fine, the barrel tip was computed correctly. It was just computed for a weapon
//   floating in the middle distance.
//
//   Every orientation number was measured off FRAME 0, and frame 0 of a UT99 view mesh is
//   the weapon mid-Select — swinging up into view, tilted and displaced. Rifle2m measures
//   7.51 units along mesh X at frame 0 against 1.70 at rest. So the earlier version of
//   this file pinned a rotation that had been fitted to a gun caught mid-swing, and
//   pinned it as though it were Epic's. It is not enough for a test to be stable.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The SHARED table, not server/weapons.js: view models are a client-rendering concern
// and the server's twin deliberately carries only what the server reasons about.
import { WEAPONS } from "../../src/shared/weapons.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const gltfOf = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

test("every weapon has a first-person view model", () => {
  for (const [id, w] of Object.entries(WEAPONS)) {
    assert.ok(w.view, `${id} has no view model`);
    assert.match(w.view.model, /^assets\/3d\/viewmodels\/.+\.gltf$/, `${id} model path`);
    assert.ok(fs.existsSync(path.join(ROOT, w.view.model)), `${id}: ${w.view.model} is missing`);
    assert.equal(w.view.muzzleLocal.length, 3, `${id} muzzle`);
  }
});

test("the geometry is already in the view frame, so nothing is rotated at draw time", () => {
  // This replaces a test that pinned Epic's RotOrigin as three Euler angles for the
  // client to apply. That was wrong twice over: the angles were composed against a mesh
  // whose axes had already been swapped, and they were fitted against frame 0. The
  // orientation is baked into the vertices now, and [0, 0, 0] is the claim being made.
  for (const [id, w] of Object.entries(WEAPONS)) {
    assert.equal(w.view.rotationDeg.length, 3, `${id} rotation`);
    for (const a of w.view.rotationDeg) assert.equal(a, 0, `${id}: rotationDeg is not zero`);
  }
});

test("every barrel points forward", () => {
  // In the view frame forward is -Z, so the muzzle is at the FRONT of the mesh: its z is
  // the minimum z of the whole model. The tolerance is the width of the band the muzzle
  // is averaged over in the extractor (the frontmost 6% of the weapon's length), not
  // slack — a weapon turned round puts the muzzle at MAXIMUM z and misses by 100%.
  for (const [id, w] of Object.entries(WEAPONS)) {
    const { min } = w.view.bboxM;
    const depth = w.view.sizeM[2];
    assert.ok(
      w.view.muzzleLocal[2] - min[2] <= 0.06 * depth,
      `${id}: muzzle z is ${w.view.muzzleLocal[2]} but the model's front is ${min[2]} — ` +
        `the barrel is not pointing forward`,
    );
    // ...and the weapon is longest along Z, because a held gun points away from the eye.
    assert.ok(
      depth === Math.max(...w.view.sizeM),
      `${id} is longest along ${"xyz"[w.view.sizeM.indexOf(Math.max(...w.view.sizeM))]}, not z`,
    );
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

test("the Enforcer is the left-hand weapon, and the only one with two meshes", () => {
  // enforcer.SetHand picks between two MIRRORED meshes, AutoML and AutoMR, and its
  // RenderOverlays forces PlayerOwner.Handedness = 1 for a lone Enforcer — so a single
  // Enforcer is always the left one, and a dual pair needs both meshes. The other five
  // ship one mesh each. Pinned because "one model per weapon" is the assumption anything
  // touching this code will make.
  assert.equal(WEAPONS.enforcer.view.hand, "left");
  assert.match(WEAPONS.enforcer.view.dualModel, /enforcer-right\.gltf$/);
  assert.ok(fs.existsSync(path.join(ROOT, WEAPONS.enforcer.view.dualModel)));
  for (const id of ["sniper", "shock", "rocket", "ripper", "redeemer"]) {
    assert.equal(WEAPONS[id].view.hand, "right", `${id} hand`);
    assert.equal(WEAPONS[id].view.dualModel, undefined, `${id} should have one mesh`);
  }
});

test("every weapon can be fired, raised and lowered", () => {
  for (const [id, w] of Object.entries(WEAPONS)) {
    const a = w.view.anims;
    assert.ok(a, `${id} has no anims`);
    assert.ok(a.fire.length > 0, `${id} has no fire animation`);
    assert.equal(typeof a.fireLoops, "boolean", `${id} fireLoops`);
    for (const f of a.fire) {
      // The rate is UnrealScript's multiplier on the clip's own fps. Zero would freeze
      // the weapon on its first frame; UT99's largest is the Ripper's 1.3, and anything
      // past 3 means an fps was written where a multiplier belongs.
      assert.ok(f.rate > 0 && f.rate <= 3, `${id} fire ${f.clip} rate ${f.rate}`);
    }
    for (const k of ["select", "down"]) {
      assert.ok(a[k], `${id} has no ${k} animation`);
      assert.ok(a[k].rate > 0 && a[k].rate <= 3, `${id} ${k} rate ${a[k].rate}`);
    }
    if (a.idle) assert.ok(a.idle.rate > 0 && a.idle.rate <= 3, `${id} idle rate`);
    if (a.idleFidget) {
      assert.ok(a.idleFidget.chance > 0 && a.idleFidget.chance < 1, `${id} fidget chance`);
    }
  }
});

test("every clip the table names is in the glTF, and is a well-formed weights track", () => {
  // The one that catches a renamed sequence. UE1 names are case-insensitive and glTF's
  // are not — the Enforcer's repeat-fire animation is `Shot2` in UnrealScript and `shot2`
  // in the package — so a clip can be named correctly in one place and be unfindable in
  // the other, at which point the weapon simply never animates and nothing errors.
  for (const [id, w] of Object.entries(WEAPONS)) {
    const models = [w.view.model, ...(w.view.dualModel ? [w.view.dualModel] : [])];
    for (const rel of models) {
      const g = gltfOf(rel);
      const targets = g.meshes[0].primitives[0].targets.length;
      assert.ok(targets > 0, `${rel} has no morph targets`);
      // Every primitive needs the same target count, or the arm stays still while the gun
      // recoils, and glTF requires it besides.
      for (const p of g.meshes[0].primitives) {
        assert.equal(p.targets.length, targets, `${rel}: primitive target count`);
      }
      assert.equal(g.meshes[0].weights.length, targets, `${rel}: default weights`);

      const byName = new Map((g.animations || []).map((a) => [a.name, a]));
      const wanted = [
        ...w.view.anims.fire.map((f) => f.clip),
        w.view.anims.select.clip,
        w.view.anims.down.clip,
        ...(w.view.anims.idle ? [w.view.anims.idle.clip] : []),
        ...(w.view.anims.idleFidget ? [w.view.anims.idleFidget.clip] : []),
      ];
      for (const clip of wanted) {
        assert.ok(byName.has(clip), `${rel}: no animation named "${clip}"`);
      }
      for (const anim of g.animations) {
        const s = anim.samplers[anim.channels[0].sampler];
        assert.equal(anim.channels[0].target.path, "weights", `${rel} ${anim.name} path`);
        assert.equal(s.interpolation, "LINEAR", `${rel} ${anim.name} interpolation`);
        const keys = g.accessors[s.input].count;
        const out = g.accessors[s.output].count;
        assert.ok(keys >= 2, `${rel} ${anim.name} has ${keys} keyframe(s)`);
        assert.equal(
          out,
          keys * targets,
          `${rel} ${anim.name}: ${out} weights for ${keys} keyframes x ${targets} targets`,
        );
      }
    }
  }
});

test("the resting pose is the mesh's own Still frame, not frame 0", () => {
  // The whole reason the orientation was wrong. Frame 0 of every one of these meshes is
  // partway through its Select sequence, so a base pose of frame 0 means all-zero morph
  // weights show the weapon mid-swing — and every derived number, muzzle included, is
  // measured on a gun that is not where it rests.
  for (const [id, w] of Object.entries(WEAPONS)) {
    const g = gltfOf(w.view.model);
    assert.ok(g.extras, `${id}: the glTF records no base pose`);
    assert.match(g.extras.baseSequence, /^(Still|Idle)$/, `${id} baseSequence`);
    assert.equal(typeof g.extras.baseFrame, "number", `${id} baseFrame`);
    // Not inside the Select sequence, which is the mistake being guarded against. Its
    // LAST frame is allowed and is often the answer — a weapon finishes being raised at
    // rest, so the Rocket Launcher's Still (19) is Select's final frame (0..19). Anything
    // earlier in that span is a weapon still on its way up.
    const select = g.extras.clips.find((c) => c.clip === "Select");
    assert.ok(select, `${id} has no Select clip recorded`);
    const last = select.startFrame + select.numFrames - 1;
    assert.ok(
      g.extras.baseFrame < select.startFrame || g.extras.baseFrame >= last,
      `${id}: base frame ${g.extras.baseFrame} is partway through Select ` +
        `(${select.startFrame}..${last}) — it is a raising pose, not a resting one`,
    );
    // And where the resting sequence is itself a clip, the two have to agree: the clip
    // named Still/Idle must start on exactly the frame the base pose was built from, or
    // playing it moves the weapon off a pose that is supposed to be its rest.
    const rest = g.extras.clips.find((c) => c.clip === g.extras.baseSequence);
    if (rest) assert.equal(rest.startFrame, g.extras.baseFrame, `${id} ${rest.clip} start`);
  }
});

test("the view shake is a shake", () => {
  // ShakeView(ShakeTime, ShakeMag, ShakeVert). Four of the six inherit at least one of
  // the three from Engine.Weapon rather than setting it, and reading only Botpack gives
  // undefined — which arrives here as a Shock Rifle that does not shake at all.
  for (const [id, w] of Object.entries(WEAPONS)) {
    for (const k of ["time", "mag", "vert"]) {
      const v = w.view.shake[k];
      assert.ok(Number.isFinite(v) && v > 0, `${id}: shake.${k} is ${v}`);
    }
  }
  // Epic's defaults, pinned: the Shock Rifle sets none of the three and must therefore
  // read exactly Engine.Weapon's 0.1 / 300 / 5.
  assert.deepEqual(WEAPONS.shock.view.shake, { time: 0.1, mag: 300, vert: 5 });
});

test("only the Enforcer and the Sniper Rifle draw a muzzle flash", () => {
  // Not an omission: the other four have no MFTexture, and Engine.Weapon.RenderOverlays
  // draws nothing without one. Pinned so that "add the missing flashes" is recognisable
  // as a change to UT99 rather than a fix.
  for (const [id, w] of Object.entries(WEAPONS)) {
    const mf = w.view.muzzleFlash;
    if (id !== "enforcer" && id !== "sniper") {
      assert.equal(mf, null, `${id} should draw no muzzle flash`);
      continue;
    }
    assert.ok(mf && mf.textures.length > 0, `${id} muzzle flash`);
    for (const t of mf.textures) {
      assert.ok(fs.existsSync(path.join(ROOT, t)), `${id}: ${t} is missing`);
    }
    for (const k of ["flashS", "muzzleScale", "flashLength", "flashY", "flashO", "flashC"]) {
      assert.ok(Number.isFinite(mf[k]), `${id}: ${k} is ${mf[k]}`);
    }
  }
  // The Enforcer picks one of five at random on every render
  // (`MFTexture = MuzzleFlashVariations[Rand(5)]`); the Sniper Rifle has one fixed.
  assert.equal(WEAPONS.enforcer.view.muzzleFlash.textures.length, 5);
  assert.equal(WEAPONS.sniper.view.muzzleFlash.textures.length, 1);
});

test("a full-screen flash goes with every shot but the sniper's", () => {
  // ClientInstantFlash(InstFlash, InstFog), and only if InstFlash != 0. The fog is already
  // through PlayerPawn's `InstantFog = 0.001 * fog`, so these are the small numbers.
  for (const [id, w] of Object.entries(WEAPONS)) {
    if (id === "sniper") {
      assert.equal(w.view.instFlash, null, "the Sniper Rifle has no InstFlash");
      continue;
    }
    const f = w.view.instFlash;
    assert.ok(f, `${id} has no instFlash`);
    assert.ok(f.scale < 0, `${id}: InstFlash is negative in every UT99 weapon`);
    assert.equal(f.fog.length, 3, `${id} fog`);
    assert.ok(
      f.fog.some((c) => c > 0) && f.fog.every((c) => c >= 0 && c < 2),
      `${id}: fog ${f.fog} does not look like 0.001 * an FVector of colour`,
    );
  }
});

test("every weapon has a select sound to go with its select animation", () => {
  // TournamentWeapon.PlaySelect plays the two together; a weapon that has the animation
  // and not the sound is half an event.
  for (const [id, w] of Object.entries(WEAPONS)) {
    assert.match(w.selectSound, /^assets\/audio\/ut\/.+\.mp3$/, `${id} select sound`);
    assert.ok(fs.existsSync(path.join(ROOT, w.selectSound)), `${id}: ${w.selectSound} is missing`);
  }
});

// ---------------------------------------------------------------------------
// The other thing that faces the wrong way.
// ---------------------------------------------------------------------------
test("the two bonus-pack bodies carry the yaw their RotOrigin does not", async () => {
  const { MODELS, VARIANTS, CHARACTER_COUNT, modelYaw } = await import(
    "../../src/shared/characters.js"
  );
  // Six UT99 meshes carry RotOrigin [0, 90, -90]; the bonus-pack ones carry [0, 0, 0].
  // The extraction used RotOrigin only to pick the UP axis — which is why all eight
  // stand 1.830 m tall — and never applied the yaw, so these two ran sideways.
  assert.equal(MODELS.skaarj.yawDeg, 90);
  assert.equal(MODELS.warcow.yawDeg, 90);
  for (const id of ["boss", "commando", "fcommando", "nali", "sgirl", "soldier"]) {
    assert.equal(MODELS[id].yawDeg, 0, `${id} should need no correction`);
  }
  // Every variant resolves to a number, including the ones needing nothing: a silent
  // undefined here would be applied as a rotation of NaN.
  for (let i = 0; i < CHARACTER_COUNT; i++) {
    assert.equal(typeof modelYaw(i), "number", `variant ${i} (${VARIANTS[i]})`);
    assert.ok(Number.isFinite(modelYaw(i)), `variant ${i} yaw is not finite`);
  }
});
