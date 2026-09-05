// effects.test.mjs — that the impact effects are placeable, the right size, and carry
// UT99's own animation.
//
// These run on the committed table and the committed glTFs, with no retail install,
// because the point is to catch the extraction having gone wrong AFTER it was extracted —
// the failure mode where a model is displaced or turned or double-scaled and every number
// still looks like a number.
//
// The three failures worth naming, because they are the ones the effects can have that
// the weapons cannot:
//
//   A WORLD EFFECT IS AIMED, not held. All four of these are spawned in UT99 with
//   Rotator(HitNormal) or rotator(fireDirection), so their forward axis is load-bearing in
//   a way a view model's is not: get it wrong and the ring lies flat on the floor in front
//   of the wall it should be stuck to. The extractor emits them in the map's own axes
//   (forward +X, up +Y) and the shape tests below are what pin that.
//
//   THE RING GROWS BY A FACTOR OF THIRTEEN. Its base pose is 0.37 m across and the last
//   frame of 'Explo' is 4.71 m. Anything that measures a ring on its base pose — a cull
//   sphere, a light radius, a test — is measuring the wrong end of it, so the manifest
//   carries the full extent and this file checks both.
//
//   DrawScale IS ALREADY IN THE VERTICES. A client that multiplies by it again gets a
//   ring 3.3 m across at frame 0 and a beam segment as long as its own spacing, and
//   nothing throws. The size assertions here are the thing that would notice.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EFFECTS, FORWARD_AXIS } from "../../src/shared/effects.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const gltfOf = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

/** One glTF accessor, as a plain array. Enough for what build-ut-effects.mjs writes. */
function accessor(g, dir, i) {
  const a = g.accessors[i];
  const v = g.bufferViews[a.bufferView];
  const bin = fs.readFileSync(path.join(dir, g.buffers[0].uri));
  const b = bin.subarray(v.byteOffset, v.byteOffset + v.byteLength);
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const out = [];
  for (let k = 0; k < a.count * n; k++) {
    out.push(a.componentType === 5123 ? b.readUInt16LE(k * 2) : b.readFloatLE(k * 4));
  }
  return out;
}

// The four effects that are a MODEL rather than a sprite. Grouped because most of what is
// asserted about them is the same thing.
const MODELS = ["shockBeam", "shockRing", "bulletImpact", "shellCase"];

test("the table is well formed", () => {
  assert.equal(FORWARD_AXIS, "+x");
  for (const key of [...MODELS, "smokePuff", "spark", "chip", "pock", "wallHit", "sounds"]) {
    assert.ok(EFFECTS[key], `EFFECTS.${key} is missing`);
  }
  for (const id of MODELS) {
    const e = EFFECTS[id];
    assert.match(e.model, /^assets\/3d\/effects\/[a-z]+\/[a-z]+\.gltf$/, `${id} model path`);
    assert.equal(e.sizeM.length, 3, `${id} sizeM`);
    assert.equal(e.bboxM.min.length, 3, `${id} bbox min`);
    assert.equal(e.bboxM.max.length, 3, `${id} bbox max`);
    assert.ok(e.drawScale > 0, `${id}: drawScale is ${e.drawScale}`);
    // Every one of these four is bUnlit and three are STY_Translucent; UE1 translucency is
    // brightness-for-opacity, so the client blends them additively or draws black cards.
    assert.equal(e.blend, "additive", `${id} blend`);
  }
  // Times are SECONDS and lengths are METRES — the whole point of the generator. A stray
  // millisecond or Unreal Unit shows up as a number three orders of magnitude out.
  for (const [id, e] of Object.entries(EFFECTS)) {
    if (e.lifeSpan === undefined) continue;
    assert.ok(e.lifeSpan > 0 && e.lifeSpan < 30, `${id}: lifeSpan ${e.lifeSpan} is not seconds`);
  }
});

test("every asset the table names is on disk", () => {
  const wanted = [
    ...MODELS.map((id) => EFFECTS[id].model),
    ...EFFECTS.smokePuff.sheets,
    EFFECTS.spark.texture,
    ...EFFECTS.pock.textures,
    ...Object.values(EFFECTS.sounds),
  ];
  for (const rel of wanted) assert.ok(exists(rel), `${rel} is missing`);
  // ...and so is everything each glTF references, which is where a half-committed
  // extraction actually shows up: the .gltf lands and its .bin or a skin does not.
  for (const id of MODELS) {
    const g = gltfOf(EFFECTS[id].model);
    const dir = path.dirname(EFFECTS[id].model);
    for (const uri of [...g.buffers.map((b) => b.uri), ...g.images.map((im) => im.uri)]) {
      assert.ok(exists(path.posix.join(dir, uri)), `${id}: ${uri} is missing`);
    }
  }
});

test("the four wall-hit sounds are UT99's own, and they are files", () => {
  // UT_WallHit.SpawnSound picks between three of these and silence; ChunkHit is what a
  // shot into a BODY plays instead. All four come out of build-ut-sounds.mjs.
  for (const [key, file] of Object.entries(EFFECTS.sounds)) {
    assert.match(file, /^assets\/audio\/ut\/[a-z0-9_]+\.mp3$/, `sounds.${key}`);
    assert.ok(exists(file), `sounds.${key}: ${file} is missing`);
    assert.ok(fs.statSync(path.join(ROOT, file)).size > 512, `sounds.${key} is suspiciously small`);
  }
  const odds = EFFECTS.wallHit.soundOdds;
  assert.equal(odds.ricochet + odds.impact1 + odds.impact2 + odds.silence, 1);
  const heavy = EFFECTS.wallHit.heavySoundOdds;
  assert.equal(heavy.ricochet + heavy.impact1 + heavy.impact2 + heavy.silence, 1);
  assert.deepEqual(EFFECTS.wallHit.ricochetPitch, [0.5, 1.5]);
});

test("the ring carries UT99's own 9-frame Explo clip", () => {
  const g = gltfOf(EFFECTS.shockRing.model);
  const dir = path.join(ROOT, path.dirname(EFFECTS.shockRing.model));
  const anim = (g.animations || []).find((a) => a.name === EFFECTS.shockRing.clip);
  assert.ok(anim, `no '${EFFECTS.shockRing.clip}' animation in ${EFFECTS.shockRing.model}`);

  const s = anim.samplers[anim.channels[0].sampler];
  const keys = accessor(g, dir, s.input);
  const weights = accessor(g, dir, s.output);
  const targets = g.meshes[0].primitives[0].targets.length;

  // UTRingex's 'Explo' is 9 frames. A LOOPING clip would carry a tenth key to wrap back to
  // the start; this one does not loop — PlayAnim runs it once and the actor is destroyed —
  // so 9 is what it should have, and 10 is the only other answer that would be defensible.
  assert.ok(keys.length === 9 || keys.length === 10, `Explo has ${keys.length} keyframes, not 9`);
  assert.equal(targets, 8, "9 frames means 8 morph targets: the first frame IS the base pose");
  // The one that actually catches a truncated buffer: a weights track is one value per
  // target per key, and nothing about a short one is visibly wrong until the ring stops
  // expanding halfway through.
  assert.equal(weights.length, keys.length * targets, "sampler output is not keys x targets");
  assert.equal(s.interpolation, "LINEAR", "UE1 interpolates between vertex frames");
  assert.equal(anim.channels[0].target.path, "weights");

  // Every key is one-hot (or all-zero, for the base frame), because a UT99 vertex
  // animation shows exactly one frame at a time.
  for (let i = 0; i < keys.length; i++) {
    const row = weights.slice(i * targets, (i + 1) * targets);
    const on = row.filter((w) => w === 1).length;
    const sum = row.reduce((t, w) => t + w, 0);
    assert.ok(on <= 1 && sum === on, `Explo key ${i} is not one-hot: ${row}`);
  }
  // Keyframes are at i / the sequence's own fps (30), with the PlayAnim rate carried
  // separately as animRate — bake the multiplier in and nobody can play the clip twice.
  assert.ok(Math.abs(keys[1] - keys[0] - 1 / 30) < 1e-6, "keyframes are not at the mesh's 30 fps");
  assert.ok(
    Math.abs(EFFECTS.shockRing.animSeconds - 9 / (30 * EFFECTS.shockRing.animRate)) < 1e-3,
    "animSeconds does not match numFrames / (fps * animRate)",
  );
});

test("the shock beam is unlit, and says so the way glTF says it", () => {
  const g = gltfOf(EFFECTS.shockBeam.model);
  assert.ok(
    (g.extensionsUsed || []).includes("KHR_materials_unlit"),
    "shockbeam.gltf does not declare KHR_materials_unlit",
  );
  for (const m of g.materials) {
    assert.ok(m.extensions?.KHR_materials_unlit, `${m.name} is not unlit`);
    // ShockBeam is Style STY_Translucent with polygon flags of zero, so the ACTOR's style
    // is the only thing that says "blend me". If that reading were dropped the material
    // would come out opaque and the beam would draw as a black tube.
    assert.equal(m.alphaMode, "BLEND", `${m.name} is not blended`);
  }
  // Every effect here is unlit — an impact flash is self-lit, and this level is a night
  // sky. The ripper blade rendering as a black disc is the bug that taught that.
  for (const id of MODELS) {
    const gg = gltfOf(EFFECTS[id].model);
    assert.ok((gg.extensionsUsed || []).includes("KHR_materials_unlit"), `${id} is not unlit`);
  }
});

test("a beam segment is a long thin streak, shorter than its own spacing", () => {
  const e = EFFECTS.shockBeam;
  const [x, y, z] = e.sizeM;
  // Longest along X, because the beam is spawned with rotator(HitLocation - muzzle) and
  // model +X is that direction. This is the assertion that catches the whole model being
  // turned: a beam lying across the line of fire would be longest on Y or Z.
  assert.ok(x > y * 10 && x > z * 10, `beam is ${x} x ${y} x ${z} m — not a streak along +X`);
  assert.ok(x > 1 && x < 3, `a beam segment is ${x} m, which is not "a couple of metres"`);
  // 135 UU of spacing is 3.17 m, and the segment does NOT fill it: UT99's beam is a dotted
  // line. If a future change made a segment longer than its stride, the beam would be a
  // solid tube and this reading of SpawnEffect would be wrong.
  assert.ok(e.spacingM > x, `a ${x} m segment does not fit in ${e.spacingM} m of spacing`);
  assert.ok(Math.abs(e.spacingM - 135 * 0.0235) < 0.01, "spacingM is not 135 UU at pawn scale");
  // The beam starts at the actor and runs forward, which is what settled the Mesh.Origin
  // question for this build: Shockbm's Origin of (0, -400, 0) is the only non-zero one
  // here, and subtracting it before the scale is what puts x_min at ~0 instead of -0.87.
  assert.ok(
    Math.abs(e.bboxM.min[0]) < 0.05,
    `the beam starts at x = ${e.bboxM.min[0]}, not at the muzzle`,
  );
  // What UT99 really draws: 40 vertices as sprites, not 76 triangles.
  assert.equal(e.particles.count, 40);
  assert.equal(e.particles.pointsM.length, 40);
  assert.ok(e.particles.sizeM > 0.3 && e.particles.sizeM < 1, `particle is ${e.particles.sizeM} m`);
  // Rotator units to radians, once: 1000000 units/s is 15.26 turns a second.
  assert.ok(
    Math.abs(e.rollRateRadPerSec - (1000000 * 2 * Math.PI) / 65536) < 0.01,
    `roll rate ${e.rollRateRadPerSec} rad/s is not RotationRate.Roll converted`,
  );
});

test("the ring is a flat ring, and it expands", () => {
  const e = EFFECTS.shockRing;
  // Zero thickness along +X: UTRingex is an annulus and its RotOrigin pitch of 90 degrees
  // is what stands it up facing the surface normal. A ring with depth means the rotation
  // was not applied.
  assert.equal(e.bboxM.min[0], 0);
  assert.equal(e.bboxM.max[0], 0);
  assert.equal(e.sizeM[0], 0, "the ring has thickness, so it is not facing along +X");
  // The base pose — what an all-zero weight vector shows.
  const base = e.bboxM.max[1] - e.bboxM.min[1];
  assert.ok(base > 0.2 && base < 1, `the ring starts ${base} m across`);
  // ...and the full extent of the clip. Round, to within a few per cent.
  assert.ok(e.sizeM[1] > 2 && e.sizeM[1] < 8, `the ring ends ${e.sizeM[1]} m across`);
  assert.ok(
    Math.abs(e.sizeM[1] - e.sizeM[2]) < 0.05 * e.sizeM[1],
    `the ring is ${e.sizeM[1]} x ${e.sizeM[2]} m — not round`,
  );
  assert.ok(e.sizeM[1] > 10 * base, "the ring does not expand");
  // Spawned 8 UU off the surface it hit.
  assert.ok(Math.abs(e.offsetAlongNormalM - 8 * 0.0235) < 0.005);
  assert.deepEqual(e.notDrawn, ["ShockExplo", "EnergyImpact"]);
});

test("the bullet impact is a flash that comes out of the wall", () => {
  const e = EFFECTS.bulletImpact;
  const [x, y, z] = e.sizeM;
  // Longest along +X, the surface normal, and starting AT the surface: this is a splash
  // spraying outwards, not a ball centred on the hit point.
  assert.ok(x > y && x > z, `impact is ${x} x ${y} x ${z} m — not pointing along the normal`);
  assert.equal(e.bboxM.min[0], 0, "the impact does not start at the surface");
  assert.ok(x > 0.3 && x < 2, `the impact is ${x} m long`);
  // No LifeSpan in UT99: AnimEnd of a one-frame sequence at PlayAnim rate 0.5, which is
  // 1/(30*0.5) seconds. A flashbulb, and the shortest-lived thing in this file.
  assert.ok(
    Math.abs(e.lifeSpan - 1 / 15) < 1e-3,
    `the impact lasts ${e.lifeSpan} s, not one frame at rate 0.5`,
  );
  assert.match(e.lifeSpanFrom, /AnimEnd/);
});

test("a shell case is the size of a shell case", () => {
  const e = EFFECTS.shellCase;
  const [x, y, z] = e.sizeM;
  // Longest along +X and roughly round in cross-section: a little cylinder.
  assert.ok(x > y && x > z, `shell is ${x} x ${y} x ${z} m — not a cylinder along +X`);
  assert.ok(Math.abs(y - z) < 0.5 * Math.max(y, z), `shell cross-section ${y} x ${z} m is not round`);
  // 16.8 cm, which is large for brass and is EPIC'S: Shellc is 7.1 UU long, and a UT99
  // pawn is 78 UU tall for 1.83 m. UT99's shell cases really are that big. The bound is
  // wide enough to allow it and narrow enough to catch a double-applied DrawScale (which
  // would put it at 33 cm) or a missing one.
  assert.ok(x > 0.05 && x < 0.25, `a shell case is ${x} m long`);
  assert.equal(e.sniperDrawScale, 2, "the Sniper Rifle ejects a double-size case");
  // Eject: forward 0.4-0.7, right 0.2-0.4, up 1.0-1.3, all times 160 UU/s. It goes UP
  // more than it goes forward, which is what makes it arc past the shooter's eye.
  assert.ok(e.ejectMPerSec.up[0] > e.ejectMPerSec.forward[1], "the case does not go up");
  for (const [k, r] of Object.entries(e.ejectMPerSec)) {
    assert.equal(r.length, 2, `ejectMPerSec.${k}`);
    assert.ok(r[0] > 0 && r[1] > r[0] && r[1] < 10, `ejectMPerSec.${k} is ${r} m/s`);
  }
  assert.ok(e.gravityMPerSec2 < -10 && e.gravityMPerSec2 > -40, `gravity ${e.gravityMPerSec2}`);
});

test("the sprites are sized by texel, and are the size they look", () => {
  // A UE1 sprite is USize * DrawScale Unreal Units across — one texel per unit at
  // DrawScale 1 — which is the same relation gen-weapons.mjs uses for the projectile
  // explosions. 32 px at DrawScale 2 is 64 UU is 1.50 m; 32 px at 0.1 is 7.5 cm.
  const smoke = EFFECTS.smokePuff;
  assert.ok(Math.abs(smoke.sizeM - 32 * 2 * 0.0235) < 0.01, `smoke puff is ${smoke.sizeM} m`);
  assert.equal(smoke.sheets.length, 4, "UT_SpriteSmokePuff picks one of four sets");
  assert.equal(smoke.frames, 8);
  assert.ok(Math.abs(smoke.animSeconds - smoke.frames * smoke.pause) < 1e-6);
  // 0.4 s of animation inside a 1.5 s life, and it drifts up the whole time.
  assert.ok(smoke.animSeconds < smoke.lifeSpan, "the puff animates for longer than it lives");
  assert.ok(smoke.risingRateMPerSec > 0.5 && smoke.risingRateMPerSec < 3);

  const spark = EFFECTS.spark;
  assert.ok(Math.abs(spark.sizeM - 32 * 0.1 * 0.0235) < 0.005, `spark is ${spark.sizeM} m`);
  assert.ok(spark.sizeM < smoke.sizeM / 10, "a spark should be far smaller than a smoke puff");
  // PHYS_Falling with bBounce, but Landed and HitWall both Destroy(): it never bounces.
  assert.equal(spark.bounces, false);
  assert.equal(spark.diesOnContact, true);

  const pock = EFFECTS.pock;
  assert.equal(pock.textures.length, 3, "Pock picks one of three at random");
  assert.ok(Math.abs(pock.sizeM - 32 * 0.19 * 0.0235) < 0.005, `pock is ${pock.sizeM} m`);
  // The one effect here that is NOT additive: a UE1 decal darkens the wall.
  assert.equal(pock.blend, "modulate");
});

test("each smoke sheet is its frames laid out left to right", () => {
  for (const rel of EFFECTS.smokePuff.sheets) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    // PNG IHDR: 8 bytes of signature, then length + "IHDR", then width and height.
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.equal(
      width,
      height * EFFECTS.smokePuff.frames,
      `${rel} is ${width}x${height} — not ${EFFECTS.smokePuff.frames} square frames in a row`,
    );
  }
});

test("a chip costs a spark, and the three wall hits differ the way UT99's do", () => {
  const { enforcer, enforcerDual, sniper } = EFFECTS.wallHit;
  for (const [id, w] of Object.entries({ enforcer, enforcerDual, sniper })) {
    assert.ok(Number.isInteger(w.maxSparks) && w.maxSparks >= 0, `${id} maxSparks`);
    assert.ok(Number.isInteger(w.maxChips) && w.maxChips >= 0, `${id} maxChips`);
    assert.ok(w.chipOdds >= 0 && w.chipOdds <= 1, `${id} chipOdds`);
  }
  // UT_HeavyWallHitEffect is the Sniper Rifle's and makes the bigger mess: MaxSparks 4
  // against 3, and ChipOdds 0.5 against 0.2. UT_LightWallHitEffect is the dual Enforcer's
  // and makes the smallest: no chips at all and a single spark.
  assert.ok(sniper.maxSparks > enforcer.maxSparks, "the sniper's hit should throw more sparks");
  assert.ok(sniper.chipOdds > enforcer.chipOdds, "the sniper's hit should chip more");
  assert.equal(enforcerDual.maxChips, 0, "a dual-Enforcer hit chips nothing");
  assert.ok(enforcerDual.maxSparks < enforcer.maxSparks);
});
