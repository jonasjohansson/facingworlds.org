#!/usr/bin/env node
// gen-effects.mjs — the impact-effect table for the client, from one source.
//
//   node scripts/gen-effects.mjs          # rewrite src/shared/effects.js
//   node scripts/gen-effects.mjs --check  # fail if out of date
//
// The build-* / gen-* split, as everywhere else here: scripts/build-ut-effects.mjs needs a
// retail UT99 install and writes scripts/data/ut-effects.json plus assets/3d/effects/**;
// this reads that JSON, converts it once, and writes a module the browser imports.
//
// THERE IS NO server/ TWIN, and that is a deliberate difference from gen-weapons.mjs and
// gen-announcer.mjs. Those two generate a pair because the server reasons about damage and
// about when the announcer speaks. Nothing here is a rule the server enforces: the server
// already tells the client where a shot landed and what it hit, and everything below is
// what the client DRAWS at that point. A server that imported this table would be carrying
// sprite sizes it can never use.
//
// ---------------------------------------------------------------------------
// UNITS
// ---------------------------------------------------------------------------
// Everything in the emitted table is METRES and SECONDS. UT99's own Unreal Units go
// through UU_TO_M (0.0235 m/UU, pawn scale — see src/shared/map-transform.js) exactly once,
// here, and the raw figure is kept beside the converted one wherever the raw one is the
// number a person would go looking for in the UnrealScript.
//
// Rotator components — UE1's 65536-to-the-turn integers — go through the same door: a
// RotationRate of 1000000 is 15.26 turns a second, which is 95.87 rad/s, and nothing
// downstream should be dividing by 65536 again.
//
// ---------------------------------------------------------------------------
// TWO THINGS THE CLIENT MUST NOT DO TWICE
// ---------------------------------------------------------------------------
// 1. DO NOT SCALE BY drawScale. Each model's DrawScale is already multiplied into its
//    vertices by the extractor, so `assets/3d/effects/ring/ring.gltf` is already the size
//    UT99 spawns a ring at. drawScale is in the table because it is Epic's number and
//    because ONE instance overrides it — the Sniper Rifle sets its shell case to 2.0 —
//    and `sniperDrawScale` is a multiplier on the committed model, not on a raw mesh.
//
// 2. DO NOT ROTATE THE MODELS INTO ANOTHER FRAME. They are emitted in the SCENE's axes
//    (map-transform's uuToScene: scene = UT.x, UT.z, UT.y), so an effect's forward is +X
//    and its up is +Y. Every one of these is spawned in UT99 with `Rotator(HitNormal)` or
//    `rotator(fireDirection)`, so pointing model +X along that vector IS the placement.
//    `forwardAxis` says so in the table rather than only in this comment.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UU_TO_M } from "../src/shared/map-transform.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT = path.join(ROOT, "src", "shared", "effects.js");
const CHECK = process.argv.includes("--check");

const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "data", "ut-effects.json"), "utf8"));
const SOUNDS = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "data", "ut-sounds.json"), "utf8"));

/** Unreal Units -> metres, to the millimetre. Nothing here needs more than that. */
const m = (n) => Math.round(n * UU_TO_M * 1000) / 1000;
const r4 = (n) => Math.round(n * 10000) / 10000;

/** One model block: its glTF, the size it really is, and how to point it. */
function model(id) {
  const d = FX.models[id];
  if (!d) throw new Error(`${id} is not in ut-effects.json — rerun build-ut-effects.mjs`);
  if (!fs.existsSync(path.join(ROOT, d.model))) throw new Error(`${d.model} is missing`);
  return {
    model: d.model,
    // The full extent over every frame of the model's clip, not just its base pose. For
    // the ring those differ by a factor of thirteen (0.37 m at frame 0, 4.71 m at frame 8)
    // and a client sizing a light or a cull sphere off the base pose would get it wrong.
    sizeM: d.extentM,
    bboxM: d.bboxM,
    drawScale: d.drawScale,
    // Every one of these four is bUnlit in UT99, and three of the four are STY_Translucent
    // — which in UE1 means BRIGHTNESS IS OPACITY, so black is invisible. Blend additively;
    // alpha-blending them leaves a black card where the effect should be.
    blend: d.style === 3 || d.unlitMaterials ? "additive" : "normal",
  };
}

// ---------------------------------------------------------------------------
// THE TABLE
// ---------------------------------------------------------------------------

const beam = FX.shockBeam;
const ring = FX.shockRing;
const impact = FX.bulletImpact;
const smoke = FX.smokePuff;
const spark = FX.spark;
const chip = FX.chip;
const pock = FX.pock;
const shell = FX.shellCase;

const EFFECTS = {
  // ShockRifle.SpawnEffect spawns ONE of these at the muzzle and each spawns the next on a
  // 50 ms timer, so the beam grows towards the hit at `spacingM` a step. It is not a line
  // from A to B: a segment is 1.73 m long against a 3.17 m stride, so UT99's beam is a
  // dotted streak and drawing it as a solid cylinder is not the same picture.
  shockBeam: {
    ...model("shockbeam"),
    lifeSpan: beam.lifeSpan,
    drawScale: beam.drawScale,
    spacingM: m(beam.spacingUU),
    spacingUU: beam.spacingUU,
    segmentIntervalS: beam.segmentIntervalS,
    // The muzzle end is Owner.Location + CalcDrawOffset() + (FireOffset.X + 20)*aim.
    muzzleForwardBonusM: m(beam.muzzleForwardBonusUU),
    // RotationRate.Roll with bFixedRotationDir — a constant spin about the beam's own axis.
    rollRateRadPerSec: r4(beam.rollRateRadPerSec),
    // SmokeRotation.roll = Rand(65535) at spawn. Without this every segment lines up and
    // the chain reads as one extruded tube instead of a flicker.
    randomStartRoll: beam.randomStartRoll,
    // Tick: ScaleGlow = Lifespan/Default.Lifespan; AmbientGlow = ScaleGlow * 210. So it
    // starts at 210/255 of full and fades linearly to nothing over its 0.27 s.
    glowMax: r4(beam.glowMax),
    // WHAT UT99 ACTUALLY DRAWS. ShockBeam has bParticles set, and Engine's Actor.uc says
    // of that flag "Mesh is a particle system": UE1 draws the mesh's 40 VERTICES as
    // camera-facing sprites of `particles.texture` and never draws its triangles. The
    // glTF above carries the triangles because a textured tube is a cheap thing for a
    // browser to draw; `particles.pointsM` carries the points, in the model's own metres,
    // for a client that wants the real thing.
    particles: {
      texture: FX.models.shockbeam.particles.texture,
      sizeM: beam.particleSizeM,
      count: FX.models.shockbeam.particles.count,
      pointsM: FX.models.shockbeam.particles.pointsM,
    },
  },

  // The Shock Rifle's hit: an expanding ring lying flat against the surface. Its 'Explo'
  // clip is 9 vertex frames as glTF morph targets, and it EXPANDS by a factor of 13 — the
  // model's base pose is the small ring, so all-zero weights are the start, not the end.
  shockRing: {
    ...model("ring"),
    clip: FX.models.ring.clip.clip,
    // A MULTIPLIER on the clip's own authored fps, which is baked into the keyframe times.
    // Playing it at UT99's speed means setting the action's timeScale to this. Duration is
    // numFrames / (fps * animRate) = 9 / (30 * 0.35) = 0.857 s, just past the 0.8 s life —
    // UT99 destroys the ring a hair before its animation finishes.
    animRate: ring.animRate,
    animSeconds: r4(FX.models.ring.clip.numFrames / (FX.models.ring.clip.fps * ring.animRate)),
    lifeSpan: ring.lifeSpan,
    drawScale: ring.drawScale,
    // Spawn(..., HitLocation + HitNormal*8, rotator(HitNormal)).
    offsetAlongNormalM: m(ring.offsetAlongNormalUU),
    // Tick: ScaleGlow = (Lifespan/Default.Lifespan)*0.7. Fades from 0.7 to 0.
    glowMax: ring.glowMax,
    // Two more actors UT99 spawns with the ring that this game does not draw. Named rather
    // than dropped: a 15-frame sprite blast and a scorch decal.
    notDrawn: ring.alsoSpawns.map((a) => a.actor),
  },

  // The flash where a bullet meets a wall, and the actor that spawns everything else in
  // `wallHit`. It has no LifeSpan in UT99 — it destroys itself when its one-frame 'Hit'
  // animation ends, which at PlayAnim rate 0.5 on a 30 fps sequence is 67 ms. A flashbulb.
  bulletImpact: {
    ...model("bulletimpact"),
    lifeSpan: impact.lifeSpan,
    lifeSpanFrom: impact.lifeSpanFrom,
    drawScale: impact.drawScale,
    // Spawned at HitLocation + HitNormal*1, turned by Rotator(HitNormal).
    offsetAlongNormalM: m(impact.offsetAlongNormalUU),
  },

  // The puff of smoke. A DT_SpriteAnimOnce actor: a camera-facing quad stepping through an
  // 8-frame chain, one of four sets picked at random per puff, drifting straight up.
  smokePuff: {
    sheets: smoke.sets.map((s) => s.path),
    // Frames run LEFT TO RIGHT on one strip; each sheet is frames x 32 px wide.
    frames: smoke.frames,
    pause: smoke.pause,
    lifeSpan: smoke.lifeSpan,
    // 8 x 0.05 s = 0.40 s of animation inside a 1.50 s life. Epic's, not a rounding: the
    // puff forms fast and then drifts on its last frame for another 1.1 s.
    animSeconds: smoke.animSeconds,
    drawScale: smoke.drawScale,
    scaleGlow: smoke.scaleGlow,
    // BeginPlay: Velocity = Vect(0,0,1)*RisingRate, under PHYS_Rotating, so it rises at a
    // constant speed and gravity never touches it.
    risingRateMPerSec: m(smoke.risingRateUU),
    // The three places UT99 spawns one, all off the call site. `objectHit` is the 9 UU the
    // Enforcer and the Sniper Rifle use when they hit a non-pawn actor rather than a wall;
    // `wallHit` is zero because UT_WallHit spawns the puff at its own location, and the
    // wall hit is itself already one unit off the surface.
    offsetAlongNormalM: m(smoke.offsetAlongNormalUU.objectHit),
    offsetAlongNormalMBy: {
      wallHit: m(smoke.offsetAlongNormalUU.wallHit),
      heavyWallHit: m(smoke.offsetAlongNormalUU.heavyWallHit),
      objectHit: m(smoke.offsetAlongNormalUU.objectHit),
    },
    // THE WORLD SIZE OF A UE1 SPRITE is its texture's own pixel size times DrawScale, in
    // Unreal Units — one texel per unit at DrawScale 1. UE1's DrawActorSprite takes
    // Texture->USize * Actor->DrawScale into world space and lets the projection divide;
    // gen-weapons.mjs already sizes the projectile explosions the same way. So 32 px at
    // DrawScale 2 is 64 UU, which is 1.50 m.
    sizeM: smoke.sizeM,
    blend: "additive",
  },

  // A spark. DT_Sprite, so a camera-facing 7.5 cm quad, thrown in a wide cone about the
  // surface normal and falling under the level's own gravity.
  spark: {
    texture: spark.texture,
    lifeSpan: spark.lifeSpan,
    drawScale: spark.drawScale,
    sizeM: spark.sizeM,
    // PostBeginPlay: Velocity = (Vector(Rotation) + VRand()) * 200 * FRand(). The direction
    // is the normal plus a full random unit vector — a cone wide enough to go sideways —
    // and the SPEED is uniform on [0, 200] UU/s, so most sparks are slow.
    speedMaxMPerSec: m(spark.speedMaxUU),
    gravityMPerSec2: m(spark.gravityUU),
    // PHYS_Falling with bBounce set, but Landed and HitWall both Destroy(), so a spark
    // never actually bounces: it dies on the first thing it touches.
    bounces: spark.bounces,
    diesOnContact: spark.diesOnContact,
    offsetAlongNormalM: m(spark.offsetAlongNormalUU),
    blend: "additive",
  },

  // A chip of the wall. No glTF: it is a 6-face pebble, and the numbers are enough for the
  // client to throw a box or a sprite instead.
  chip: {
    lifeSpan: chip.lifeSpan,
    // BeginState: Velocity = VRand()*200*FRand() + Vector(Rotation)*250.
    launchAlongNormalMPerSec: m(chip.launchAlongNormalUU),
    scatterMaxMPerSec: m(chip.scatterMaxUU),
    drawScaleRange: chip.drawScaleRange,
    spinMaxRadPerSec: r4((chip.spinMaxUU * 2 * Math.PI) / 65536),
    bounces: chip.bounces,
  },

  // The decal. UT99 attaches one of three 32 px marks to the surface, 14 cm across, and
  // keeps it for the better part of twenty seconds. It is the ONE effect here that is not
  // additive: a UE1 decal is projected modulated, so it darkens the wall rather than
  // lighting it.
  pock: {
    textures: pock.textures.map((t) => t.path),
    sizeM: pock.sizeM,
    drawScale: pock.drawScale,
    lifeSeconds: pock.lifeSeconds,
    blend: pock.blend,
  },

  // The brass. Ejected on every Enforcer and Sniper Rifle shot, in the SHOOTER's axes.
  shellCase: {
    ...model("shellcase"),
    lifeSpan: shell.lifeSpan,
    drawScale: shell.drawScale,
    // The Sniper Rifle sets s.DrawScale = 2.0 before ejecting. A multiplier on the
    // committed model, which is already at DrawScale 1.
    sniperDrawScale: shell.sniperDrawScale,
    // Eject: ((FRand()*0.3+0.4)*forward + (FRand()*0.2+0.2)*right + (FRand()*0.3+1.0)*up)*160.
    // Each range is [min, max] metres per second; pick uniformly inside each.
    ejectMPerSec: {
      forward: shell.ejectUU.forward.map(m),
      right: shell.ejectUU.right.map(m),
      up: shell.ejectUU.up.map(m),
    },
    spawnOffsetM: { enforcer: m(20), sniper: m(30) },
    // Eject also calls RandSpin(100000): a random axis at up to this rate.
    spinMaxRadPerSec: r4(shell.spinMaxRadPerSec),
    gravityMPerSec2: m(shell.gravityUU),
    bounces: shell.bounces,
    maxBounces: shell.maxBounces,
    // HitWall halves the speed and reflects about a jittered normal...
    bounceRestitution: shell.bounceRestitution,
    // ...and then usually stops: bBounce is cleared with this probability on any bounce
    // after the first, and always after three.
    bounceStopChance: shell.bounceStopChance,
  },

  // How much of a mess one shot makes. A CHIP SPAWNED COSTS A SPARK in both classes — the
  // budgets trade against each other rather than adding up — so the order is: roll
  // `maxSparks` for a spark count, then for each of `maxChips` roll `chipOdds` and
  // decrement the spark count on a hit.
  wallHit: {
    enforcer: budget(FX.wallHit.enforcer),
    // A dual-Enforcer shot uses UT_LightWallHitEffect instead: no chips, one spark.
    enforcerDual: budget(FX.wallHit.enforcerDual),
    sniper: budget(FX.wallHit.sniper),
    // UT_WallHit.SpawnSound: one FRand() decides between three sounds and silence.
    soundOdds: FX.wallHit.soundOdds,
    // UT_HeavyWallHitEffect's, which is never silent.
    heavySoundOdds: FX.wallHit.heavySoundOdds,
    // PlaySound(sound'ricochet',, 1.5,,1200, 0.5+FRand()) — the ricochet alone is
    // pitch-shifted, over a 3:1 range, every time it plays.
    ricochetPitch: FX.wallHit.ricochetPitch,
  },

  sounds: {
    chunkHit: SOUNDS.impact.chunkhit.file,
    impact1: SOUNDS.impact.impact1.file,
    impact2: SOUNDS.impact.impact2.file,
    ricochet: SOUNDS.impact.ricochet.file,
  },
};

/** One wall-hit class's spark/chip budget, without the extractor's provenance fields. */
function budget(w) {
  return { maxSparks: w.maxSparks, maxChips: w.maxChips, chipOdds: w.chipOdds };
}

// Every asset the table names has to be on disk, or the client 404s at the worst possible
// moment. Checked HERE rather than only in the test, because a generator that writes a
// path to a file that does not exist has already failed.
for (const p of [
  ...EFFECTS.smokePuff.sheets,
  EFFECTS.spark.texture,
  ...EFFECTS.pock.textures,
  ...Object.values(EFFECTS.sounds),
  ...["shockBeam", "shockRing", "bulletImpact", "shellCase"].map((k) => EFFECTS[k].model),
]) {
  if (!fs.existsSync(path.join(ROOT, p))) throw new Error(`${p} is missing — rerun the build-* scripts`);
}

const out = `// GENERATED by scripts/gen-effects.mjs — DO NOT EDIT.
//
// What UT99 draws where a shot LANDS: the Shock Rifle's beam and its expanding ring, the
// flash and smoke and sparks and chips and decal of a bullet hitting a wall, and the shell
// case the gun throws out. Every number is Epic's, read out of BotPack.u and UnrealShare.u
// by scripts/build-ut-effects.mjs — see its header for the UnrealScript each one came from.
//
// LENGTHS ARE METRES and times are SECONDS; the raw Unreal Units are kept beside the few
// that a reader would go looking for in the script. Rotation rates are radians per second,
// converted once from UE1's 65536-to-the-turn integers.
//
// TWO THINGS NOT TO DO TWICE:
//
//   Do not scale a model by its \`drawScale\`. Each glTF already has UT99's DrawScale
//   multiplied into its vertices. The field is here because it is Epic's number and
//   because one instance overrides it — \`shellCase.sniperDrawScale\` is a multiplier on
//   the committed model.
//
//   Do not rotate a model into another frame. They are emitted in the SCENE's axes
//   (src/shared/map-transform.js's uuToScene), so FORWARD IS +X and UP IS +Y. UT99 spawns
//   every one of them with Rotator(HitNormal) or rotator(fireDirection), so pointing model
//   +X along that vector is the whole of the placement.
//
// \`blend: "additive"\` is not a taste call either. These actors are STY_Translucent, and a
// translucent UE1 surface has BRIGHTNESS FOR OPACITY — black is invisible. Alpha-blend
// them instead and every effect draws as a black card. The one exception is the decal,
// which UE1 projects modulated so it darkens the wall.

/** Which model axis is the effect's "forward" — see the header. */
const FORWARD_AXIS = "+x";

const EFFECTS = ${JSON.stringify(EFFECTS, null, 2)};

export { EFFECTS, FORWARD_AXIS };
`;

if (CHECK) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (cur !== out) {
    console.error(`${path.relative(ROOT, OUT)} out of date — run: node scripts/gen-effects.mjs`);
    process.exit(1);
  }
  console.log("effects table is up to date.");
  process.exit(0);
}
fs.writeFileSync(OUT, out);
console.log(
  `wrote the effects table — ${Object.keys(EFFECTS).length - 1} effects and ${Object.keys(EFFECTS.sounds).length} sounds\n` +
    `  beam    ${EFFECTS.shockBeam.sizeM[0].toFixed(2)} m segments every ${EFFECTS.shockBeam.spacingM.toFixed(2)} m, ` +
    `${EFFECTS.shockBeam.particles.count} particles of ${EFFECTS.shockBeam.particles.sizeM.toFixed(2)} m\n` +
    `  ring    ${EFFECTS.shockRing.bboxM.max[1] * 2} m -> ${EFFECTS.shockRing.sizeM[1].toFixed(2)} m across in ${EFFECTS.shockRing.animSeconds.toFixed(2)} s\n` +
    `  impact  ${EFFECTS.bulletImpact.sizeM[0].toFixed(2)} m for ${(EFFECTS.bulletImpact.lifeSpan * 1000).toFixed(0)} ms\n` +
    `  smoke   ${EFFECTS.smokePuff.sizeM.toFixed(2)} m, ${EFFECTS.smokePuff.sheets.length} sheets of ${EFFECTS.smokePuff.frames}\n` +
    `  shell   ${(EFFECTS.shellCase.sizeM[0] * 100).toFixed(1)} cm (x${EFFECTS.shellCase.sniperDrawScale} for the sniper)`,
);
