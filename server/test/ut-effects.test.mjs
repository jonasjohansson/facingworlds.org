// ut-effects.test.mjs — the arithmetic behind UT99's hit effects, pinned to the .uc.
//
// ut-effects.js is a rendering module and most of it cannot be tested without a GPU. Four
// things in it can, and all four are the kind that fail silently on screen rather than
// throwing: the ShockBeam segment count, the distance falloff on the impact sounds,
// UT_WallHit's four-way sound roll (including the quarter that is DELIBERATELY silent, and
// so looks exactly like a bug), and the defensive readers that keep a missing or renamed
// field in the generated src/shared/effects.js from turning a lifespan into NaN.
//
// THE FILE UNDER TEST IS src/game/systems/ut-effects.js — the three r180 port, the one the
// client actually runs. It used to be the A-Frame component, which needed a hand-built
// global THREE stub to survive being evaluated in Node; the port removed the
// need for it. `import * as THREE from "three"` resolves to the devDependency here exactly
// as the import map resolves it in the browser, so this test loads the real r180 module,
// and neither ut-effects.js nor the modules it pulls in (impact-effects.js, hitscan.js,
// engine/assets.js) touch `window`, `document` or a GL context at module scope. Nothing is
// faked: the helpers below are the shipped ones.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UU_TO_M } from "../../src/shared/map-transform.js";
import { EFFECTS, FORWARD_AXIS } from "../../src/shared/effects.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const { pickNum, pickStr, pickObj, pickArr, beamChain, attenuate, wallHitSound } = await import(
  "../../src/game/systems/ut-effects.js"
);

// ---------------------------------------------------------------------------
// the defensive readers
// ---------------------------------------------------------------------------

test("a field the generated contract does not carry falls back to Epic's own number", () => {
  // The whole point: src/shared/effects.js is generated, and a rename upstream must cost a
  // fallback rather than a NaN that quietly makes every beam segment live forever.
  assert.equal(pickNum(null, ["lifeSpan"], 0.27), 0.27);
  assert.equal(pickNum({}, ["lifeSpan"], 0.27), 0.27);
  assert.equal(pickNum({ lifeSpan: "0.27" }, ["lifeSpan"], 0.27), 0.27, "a string is not a number");
  assert.equal(pickNum({ lifeSpan: NaN }, ["lifeSpan"], 0.27), 0.27);
  assert.equal(pickNum({ lifeSpan: 0 }, ["lifeSpan"], 0.27), 0, "zero is a value, not an absence");
  assert.equal(pickNum({ lifeSpan: 0.4 }, ["lifeSpan"], 0.27), 0.4);
});

test("the reader takes the FIRST name it recognises, so a rename is survivable", () => {
  assert.equal(pickNum({ speedMaxMPerSec: 6 }, ["speedMPerSec", "speedMaxMPerSec"], 4), 6);
  assert.equal(pickNum({ speedMPerSec: 3, speedMaxMPerSec: 6 }, ["speedMPerSec", "speedMaxMPerSec"], 4), 3);
  assert.equal(pickStr({ model: "a.gltf" }, ["model"], ""), "a.gltf");
  assert.equal(pickStr({ model: "" }, ["model"], "fallback"), "fallback", "empty is an absence");
  assert.equal(pickObj({ shockBeam: { a: 1 } }, ["shockBeam"]).a, 1);
  assert.equal(pickObj({ shockBeam: 3 }, ["shockBeam"]), null);
  assert.equal(pickArr({ sheets: [] }, ["sheets"]), null, "an empty sheet list is no sheets");
  assert.equal(pickArr({ sheets: ["a.png"] }, ["sheets"]).length, 1);
});

// ---------------------------------------------------------------------------
// ShockRifle.SpawnEffect
// ---------------------------------------------------------------------------

test("the beam lays one ShockBeam every 135 UU, as SpawnEffect does", () => {
  // NumPoints = VSize(HitLocation - HitStart) / 135, in Unreal Units.
  const spacing = 135 * UU_TO_M; // 3.1725 m at this build's 0.0235 m/UU
  assert.ok(Math.abs(spacing - 3.1725) < 0.001, `spacing was ${spacing}`);

  // A ten-spacing shot is ten segments, and MoveAmount is the distance divided by them.
  const ten = beamChain(spacing * 10, spacing, 64);
  assert.equal(ten.count, 10);
  assert.ok(Math.abs(ten.step - spacing) < 1e-9);

  // The chain always reaches the wall: count * step is the whole distance, whatever the
  // rounding did to count. This is the invariant that keeps a beam from stopping short.
  for (const d of [0.6, 3, 7.4, 19, 48.5, 137, 400]) {
    const c = beamChain(d, spacing, 40);
    assert.ok(Math.abs(c.count * c.step - d) < 1e-9, `chain fell short at ${d} m`);
    assert.ok(c.count >= 1, "a shot always draws at least one segment");
  }
});

test("a shot longer than the pool stretches its spacing instead of stopping short", () => {
  const spacing = 135 * UU_TO_M;
  // 400 m of MAX_RANGE would be 126 segments at Epic's spacing — more than the per-shot cap.
  const capped = beamChain(400, spacing, 40);
  assert.equal(capped.count, 40, "the cap holds");
  assert.equal(capped.step, 10, "and the beam still ends at the wall");
});

// ---------------------------------------------------------------------------
// the impact sounds
// ---------------------------------------------------------------------------

test("volume is flat close in and falls away with distance", () => {
  assert.equal(attenuate(0, 8), 1, "at the camera, full volume");
  assert.equal(attenuate(8, 8), 0.5, "half at the reference radius");
  assert.ok(attenuate(80, 8) < 0.1, "across the map, nearly gone");
  let last = Infinity;
  for (let d = 0; d < 120; d += 5) {
    const v = attenuate(d, 8);
    assert.ok(v < last, "monotonically quieter");
    assert.ok(v > 0, "never silent by division");
    last = v;
  }
});

test("UT_WallHit's sound is Rand(4), and one quarter of it is silence", () => {
  const sounds = { ricochet: "ric.mp3", impact1: "i1.mp3", impact2: "i2.mp3", chunkHit: "flesh.mp3" };
  // The Enforcer's table, straight out of the contract.
  const odds = { ricochet: 0.25, impact1: 0.25, impact2: 0.25, silence: 0.25 };
  const pitch = [0.5, 1.5];

  assert.equal(wallHitSound(sounds, odds, pitch, 0.0, 0).src, "ric.mp3");
  assert.equal(wallHitSound(sounds, odds, pitch, 0.24, 0).src, "ric.mp3");
  assert.equal(wallHitSound(sounds, odds, pitch, 0.25, 0).src, "i1.mp3");
  assert.equal(wallHitSound(sounds, odds, pitch, 0.5, 0).src, "i2.mp3");
  assert.equal(wallHitSound(sounds, odds, pitch, 0.75, 0), null, "the silent quarter is Epic's, not a bug");
  assert.equal(wallHitSound(sounds, odds, pitch, 0.999999, 0), null);

  // PlaySound(Ricochet, ..., 0.5 + FRand()) — half to one-and-a-half speed, never zero.
  assert.equal(wallHitSound(sounds, odds, pitch, 0, 0).rate, 0.5);
  assert.equal(wallHitSound(sounds, odds, pitch, 0, 1).rate, 1.5);
  assert.equal(wallHitSound(sounds, odds, pitch, 0.3, 0.9).rate, 1, "only the ricochet is repitched");

  // A contract with no sounds block at all must be silent, not a crash. So must a table
  // whose sound the extraction did not ship.
  assert.equal(wallHitSound(null, odds, pitch, 0.1, 0.5), null);
  assert.equal(wallHitSound({}, odds, pitch, 0.1, 0.5), null);
  assert.equal(wallHitSound({ impact1: "i1.mp3" }, odds, pitch, 0.1, 0.5), null, "no ricochet shipped, none played");

  // Missing odds fall back to Epic's own even quarters rather than to a silent gun.
  assert.equal(wallHitSound(sounds, null, null, 0.1, 0).src, "ric.mp3");
  assert.equal(wallHitSound(sounds, null, null, 0.4, 0).src, "i1.mp3");
  assert.equal(wallHitSound(sounds, null, null, 0.8, 0), null);
});

test("UT_HeavyWallHitEffect's table is a different one, and never silent", () => {
  // The Sniper Rifle: half ricochets, quarter each impact, NO silence. Read from the table,
  // not written here — this is the reason the odds are an argument.
  const sounds = { ricochet: "ric.mp3", impact1: "i1.mp3", impact2: "i2.mp3" };
  const heavy = { ricochet: 0.5, impact1: 0.25, impact2: 0.25, silence: 0 };
  const pitch = [0.5, 1.5];
  assert.equal(wallHitSound(sounds, heavy, pitch, 0.49, 0).src, "ric.mp3");
  assert.equal(wallHitSound(sounds, heavy, pitch, 0.51, 0).src, "i1.mp3");
  assert.equal(wallHitSound(sounds, heavy, pitch, 0.76, 0).src, "i2.mp3");
  assert.notEqual(wallHitSound(sounds, heavy, pitch, 0.999, 0), null, "the sniper is never silent");
});

test("the four buckets come up as often as Epic says", () => {
  const sounds = { ricochet: "ric.mp3", impact1: "i1.mp3", impact2: "i2.mp3" };
  const odds = { ricochet: 0.25, impact1: 0.25, impact2: 0.25, silence: 0.25 };
  const counts = { "ric.mp3": 0, "i1.mp3": 0, "i2.mp3": 0, silent: 0 };
  // A tiny LCG, so this is a fact about the function rather than about today's Math.random.
  let s = 12345;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 4294967296);
  for (let i = 0; i < 4000; i++) {
    const r = wallHitSound(sounds, odds, [0.5, 1.5], rnd(), rnd());
    counts[r ? r.src : "silent"]++;
  }
  for (const [k, n] of Object.entries(counts)) {
    assert.ok(n > 850 && n < 1150, `${k} came up ${n} times in 4000, expected about 1000`);
  }
});

// ---------------------------------------------------------------------------
// the committed contract, against what ut-effects.js actually reads out of it
// ---------------------------------------------------------------------------
//
// src/shared/effects.js is GENERATED. The renderer reads every field through a fallback so
// a rename cannot break a shot, but a silent fallback is still a silent regression: the
// Shock Rifle would quietly go back to a 3.17 m default spacing that happens to be right
// today and would not be if UU_TO_M ever moved. This is the test that notices.

test("every asset the contract names is committed", () => {
  const files = [
    EFFECTS.shockBeam.model,
    EFFECTS.shockRing.model,
    EFFECTS.bulletImpact.model,
    EFFECTS.shellCase.model,
    EFFECTS.spark.texture,
    ...EFFECTS.smokePuff.sheets,
    ...EFFECTS.pock.textures,
    ...Object.values(EFFECTS.sounds),
  ];
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is named by the contract but not on disk`);
  }
});

test("the fields ut-effects.js reads are the ones the generator writes", () => {
  // Written out by name rather than looped, because the point is to fail when one of THESE
  // disappears — the reader would fall back and nothing would look broken.
  const required = {
    shockBeam: ["model", "lifeSpan", "spacingM", "segmentIntervalS", "rollRateRadPerSec", "glowMax", "muzzleForwardBonusM", "particles"],
    shockRing: ["model", "clip", "animRate", "lifeSpan", "offsetAlongNormalM", "glowMax"],
    bulletImpact: ["model", "lifeSpan", "offsetAlongNormalM"],
    smokePuff: ["sheets", "frames", "pause", "lifeSpan", "scaleGlow", "risingRateMPerSec", "sizeM"],
    spark: ["texture", "lifeSpan", "sizeM", "speedMaxMPerSec", "gravityMPerSec2", "offsetAlongNormalM"],
    pock: ["textures", "sizeM", "lifeSeconds", "blend"],
    shellCase: ["model", "lifeSpan", "sniperDrawScale", "ejectMPerSec", "spawnOffsetM", "gravityMPerSec2", "spinMaxRadPerSec", "bounceRestitution", "maxBounces", "bounceStopChance"],
    wallHit: ["enforcer", "enforcerDual", "sniper", "soundOdds", "heavySoundOdds", "ricochetPitch"],
    sounds: ["chunkHit", "impact1", "impact2", "ricochet"],
  };
  for (const [block, keys] of Object.entries(required)) {
    assert.ok(EFFECTS[block], `EFFECTS.${block} is gone`);
    for (const k of keys) {
      assert.notEqual(EFFECTS[block][k], undefined, `EFFECTS.${block}.${k} is gone`);
    }
  }
  // The beam is drawn as UE1 particles, so the forty points and their sprite size are load
  // bearing in a way the mesh's triangles are not — see the header of ut-effects.js.
  assert.equal(EFFECTS.shockBeam.particles.pointsM.length, EFFECTS.shockBeam.particles.count);
  assert.ok(EFFECTS.shockBeam.particles.sizeM > 0);
  for (const p of EFFECTS.shockBeam.particles.pointsM) assert.equal(p.length, 3);

  for (const k of ["forward", "right", "up"]) {
    assert.equal(EFFECTS.shellCase.ejectMPerSec[k].length, 2, `ejectMPerSec.${k} is not a [lo, hi] pair`);
  }
});

test("the beam's spacing is 135 UU through THIS build's scale, not a rounded constant", () => {
  assert.ok(
    Math.abs(EFFECTS.shockBeam.spacingM - EFFECTS.shockBeam.spacingUU * UU_TO_M) < 0.001,
    `spacingM ${EFFECTS.shockBeam.spacingM} does not match ${EFFECTS.shockBeam.spacingUU} UU at ${UU_TO_M} m/UU`,
  );
});

test("gravity is a signed acceleration, not a magnitude", () => {
  // ut-effects.js ADDS these to velocity.y each frame. A sign flip upstream would send
  // every spark and every shell case into the ceiling.
  assert.ok(EFFECTS.spark.gravityMPerSec2 < 0, "spark gravity points up");
  assert.ok(EFFECTS.shellCase.gravityMPerSec2 < 0, "shell gravity points up");
});

test("the models are longest along the forward axis the contract declares", () => {
  // The one property the renderer cannot check for itself until the glTF has loaded in a
  // browser: point the wrong axis down the shot and the beam draws as a fence of bars
  // across it. The ring is exempt — it is FLAT along its forward axis, which is the point.
  assert.equal(FORWARD_AXIS, "+x");
  const axis = 0; // +x
  for (const key of ["shockBeam", "bulletImpact", "shellCase"]) {
    const s = EFFECTS[key].sizeM;
    assert.ok(s[axis] > s[1] && s[axis] > s[2], `${key} is not longest along ${FORWARD_AXIS}`);
  }
  assert.equal(EFFECTS.shockRing.sizeM[axis], 0, "the ring should be flat along its forward axis");
});

test("the smoke sheets are one row of `frames` square cells", () => {
  // The renderer sets repeat = 1/frames on x and 1 on y and walks offset.x left to right.
  // A sheet that is not laid out that way plays as a smear.
  const png = (f) => {
    const b = fs.readFileSync(path.join(ROOT, f)).subarray(16, 24);
    return [b.readUInt32BE(0), b.readUInt32BE(4)];
  };
  for (const sheet of EFFECTS.smokePuff.sheets) {
    const [w, h] = png(sheet);
    assert.equal(w, h * EFFECTS.smokePuff.frames, `${sheet} is ${w}x${h}, not ${EFFECTS.smokePuff.frames} cells wide`);
  }
});
