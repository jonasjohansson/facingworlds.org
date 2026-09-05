#!/usr/bin/env node
// build-ut-effects.mjs — the IMPACT effects, out of UT99 and into glTF.
//
//   node scripts/build-ut-effects.mjs [path-to-UT-System]
//
// DEV TOOLING, like build-ut-viewmodels.mjs and build-ut-projectiles.mjs: it needs a
// retail install, so it is not part of any build. It writes assets/3d/effects/**, those
// are committed, and gen-effects.mjs reads scripts/data/ut-effects.json.
//
// Until now the game drew nothing at all where a shot LANDED. UT99 draws a great deal:
// the Shock Rifle's beam is a chain of actors, its hit is an expanding ring plus a sprite
// blast, and a bullet hitting a wall is five separate actors (a mesh flash, a decal, a
// smoke puff, up to four sparks and up to two chips) plus one of three sounds. All of it
// is in the packages and none of it needed inventing.
//
// ---------------------------------------------------------------------------
// WHAT THE UNREALSCRIPT ACTUALLY SAYS
// ---------------------------------------------------------------------------
// Read out of BotPack.u and UnrealShare.u with scripts/lib/upkg.mjs, not remembered. The
// numbers all end up in ut-effects.json; these are the shapes they come in.
//
// THE SHOCK BEAM is a chain, not a line. ShockRifle.SpawnEffect:
//
//     DVector   = HitLocation - SmokeLocation;
//     NumPoints = VSize(DVector)/135.0;      if ( NumPoints < 1 ) return;
//     SmokeRotation = rotator(DVector);  SmokeRotation.roll = Rand(65535);
//     Smoke = Spawn(class'ShockBeam',,,SmokeLocation,SmokeRotation);
//     Smoke.MoveAmount = DVector/NumPoints;  Smoke.NumPuffs = NumPoints - 1;
//
// and each ShockBeam's 0.05 s Timer spawns the next one at Location + MoveAmount with
// NumPuffs - 1. So the beam GROWS from the muzzle at one segment every 50 ms, each
// segment is a copy of the same mesh, and the spacing is 135 UU — which is NOT the length
// of a segment: Shockbm measures 73.7 UU along the actor's forward axis at its DrawScale
// of 0.44. UT99's beam is a dotted line, and it is meant to be.
//
// SmokeLocation is the muzzle, offset by (FireOffset.X + 20) along the aim.
//
// THE SHOCK HIT is `Spawn(class'ut_RingExplosion5',,, HitLocation+HitNormal*8,
// rotator(HitNormal))`. UT_RingExplosion plays 'Explo' at 0.35 and per tick sets
// `ScaleGlow = (Lifespan/Default.Lifespan)*0.7; AmbientGlow = ScaleGlow*255`, so it fades
// from 0.7 to 0 over its 0.8 s. It ALSO spawns two more actors that this build does not
// model, and they are named in ut-effects.json rather than quietly dropped: `shockexplo`
// (a 15-frame DT_SpriteAnimOnce blast on asmdex_a00, with a blue light) and, from
// UT_RingExplosion5 only, an `EnergyImpact` scorch decal.
//
// A BULLET HITTING A WALL is `Spawn(class'UT_WallHit',,, HitLocation+HitNormal,
// Rotator(HitNormal))` — one unit off the surface, not on it — and UT_WallHit.SpawnEffects
// then spawns, in this order:
//
//     a sound     25% ricochet (volume 1.5, pitch 0.5+FRand()), 25% Impact1, 25% Impact2,
//                 25% nothing.  UT_HeavyWallHitEffect (the Sniper Rifle's) shifts that to
//                 50% ricochet / 25% / 25% and never stays silent.
//     0..MaxChips Chip, each at ChipOdds. Enforcer 2 at 0.2, Sniper 2 at 0.5. Every chip
//                 spawned DECREMENTS the spark budget.
//     a Pock      a decal, one of pock0_t / pock2_t / pock4_t at random.
//     one puff    UT_SpriteSmokePuff, at the wall hit's own location for UT_WallHit and at
//                 Location + 8*Vector(Rotation) for the heavy one.
//     0..NumSparks UT_Spark, at Location + 8 * Vector(Rotation).
//
// UT_WallHit extends BULLETIMPACT, which is itself the visible flash: mesh BulletImpact,
// DrawScale 0.28, Style STY_Translucent, AmbientGlow 255, bUnlit, and it destroys itself
// on AnimEnd of a ONE-FRAME 'Hit' sequence played at rate 0.5 — see the lifespan note
// below. So "the wall hit" is one actor that is both the flash and the spawner.
//
// A SHELL CASE comes out on every Enforcer and Sniper shot, from their ProcessTraceHit:
//
//     s.Eject(((FRand()*0.3+0.4)*X + (FRand()*0.2+0.2)*Y + (FRand()*0.3+1.0) * Z)*160);
//
// with the Sniper Rifle's `s.DrawScale = 2.0` first. X/Y/Z are the shooter's aim axes
// (forward/right/up), so a case leaves forward-right-and-mostly-UP at 64..112 forward,
// 32..64 right and 160..208 UU/s up. UT_ShellCase.Eject also RandSpin(100000).
//
// ---------------------------------------------------------------------------
// THREE THINGS I HAD WRONG BEFORE READING THE SCRIPT
// ---------------------------------------------------------------------------
// 1. `shockexplo` IS NOT A LIGHT. It has a light on it, but it is an AnimSpriteEffect:
//    15 frames of a 128x128 sprite, Pause 0.05, LifeSpan 0.7, Style 3.
// 2. UT_RingExplosion IS NOT "Style 0 (normal)". The ACTOR carries Style = STY_None, but
//    the MESH's own polygon flags are 0x400104 — PF_Unlit | PF_TwoSided | PF_Translucent
//    — and the actor is bUnlit as well. It is an additive, two-sided, unlit ring.
// 3. THE SHOCK BEAM IS A PARTICLE SYSTEM, not a textured tube. ShockBeam's defaults carry
//    `bParticles = true`, and Engine's Actor.uc says of that flag, in as many words,
//    "Mesh is a particle system": UE1 then draws each of the mesh's vertices as a
//    camera-facing sprite of the actor's Texture rather than drawing its triangles at all.
//    So UT99's beam segment is 40 blobs of jenergy2, each 0.44 * 64 = 28 UU across, strung
//    along a 73.7 UU line. UT_Sparks is built the same way, which is the corroboration.
//
//    The triangles ARE in the package (76 of them) and they are exported here, because a
//    textured tube is a reasonable thing for a browser to draw and the client should not
//    have to re-read the mesh to get the points. But the manifest carries the particle
//    reading beside it — `particles.pointsM`, the 40 vertices in model metres — so that
//    whichever way the client draws it, it is drawing Epic's own geometry.
//
// ---------------------------------------------------------------------------
// THE FRAME: THE MAP'S, NOT THE VIEW MODELS'
// ---------------------------------------------------------------------------
// These are WORLD actors. A view model is emitted in a view frame because the client
// draws it with no rotation at all; an impact effect is placed and turned in the scene,
// so it has to arrive in the same axes the map arrives in. src/shared/map-transform.js:
//
//     uuToScene(x, y, z) -> { x: k*x + ox,  y: k*z + oy,  z: k*y + oz }
//
// i.e. scene = (UT.x, UT.z, UT.y): UT forward stays +X, UT up becomes +Y, UT right
// becomes +Z. That is a single axis swap, determinant -1, which is exactly the handedness
// flip UT (left-handed) -> glTF (right-handed) and is why the winding is reversed below.
//
// So in every model this writes, THE ACTOR'S FORWARD IS +X AND UP IS +Y. For the ring,
// the bullet impact and the shell case that is not decoration: all three are spawned with
// `Rotator(HitNormal)`, so aligning model +X with the surface normal is the whole of their
// placement. The beam is spawned with `rotator(DVector)`, so +X is the direction of fire.
//
// Mesh.Origin is subtracted BEFORE Mesh.Scale, which is the rule scripts/build-ut-characters.mjs
// measured on eight pawns. Only one mesh here has a non-zero Origin — Shockbm, (0, -400, 0)
// — and it is a third independent confirmation of the rule: subtracting first puts the
// beam segment at x = 0.1 .. 73.8, i.e. starting at the actor and running FORWARD, which
// is the only place a beam spawned at the muzzle can be. Ignoring Origin centres it on the
// muzzle (-36.9 .. 36.9) and adding it puts the whole thing BEHIND the player (-73.8 .. -0.1).
//
// ---------------------------------------------------------------------------
// HOW LONG AN EFFECT LASTS WHEN IT HAS NO LifeSpan
// ---------------------------------------------------------------------------
// BulletImpact has no LifeSpan. It destroys itself in AnimEnd, so its life is the length
// of the animation, and UE1's PlayAnim sets `AnimRate = Rate * Seq->Rate / Seq->NumFrames`
// with AnimFrame running 0 -> 1. So a sequence lasts NumFrames / (Seq.Rate * Rate)
// seconds. That is not asserted, it is CHECKED against the one effect here that has both:
// the ring's 'Explo' is 9 frames at 30 fps played at 0.35 -> 0.857 s, against a declared
// LifeSpan of 0.800 s. Within 7%, and on the right side (UT99 kills the ring a hair before
// its animation ends). BulletImpact's 'Hit' is 1 frame at 30 fps at rate 0.5 -> 0.067 s:
// a flashbulb, which is what a bullet impact spark is.
//
// TEXTURES come from scripts/lib/utex.mjs — palettes resolved by reference, see its header.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadPackage, classDefaults, readProperties } from "./lib/upkg.mjs";
import { readMesh } from "./lib/umesh.mjs";
import { readTexture } from "./lib/utex.mjs";
import { writePng } from "./lib/png.mjs";
import { UU_TO_M } from "../src/shared/map-transform.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT_DIR = path.join(ROOT, "assets", "3d", "effects");
const FX_DIR = path.join(OUT_DIR, "fx");
const OUT_JSON = path.join(ROOT, "scripts", "data", "ut-effects.json");
const SYSTEM =
  process.argv[2] || path.join(os.homedir(), "Downloads", "Unreal Tournament", "System");

// UE1 PolyFlags, the ones that change how a surface draws.
const PF_MASKED = 0x00000002;
const PF_TRANSLUCENT = 0x00000004;
const PF_TWOSIDED = 0x00000100;
const PF_UNLIT = 0x00400000;

// Actor.ERenderStyle, from Engine's own Actor.uc: STY_None, STY_Normal, STY_Masked,
// STY_Translucent, STY_Modulated. A translucent UE1 surface has brightness FOR opacity,
// so black is invisible and the client blends it additively — the same reading
// gen-weapons.mjs makes of the projectile explosions.
const STY_TRANSLUCENT = 3;

// ---------------------------------------------------------------------------
// PACKAGES
// ---------------------------------------------------------------------------
// Botpack holds the shock and bullet effects; UnrealShare holds Chip and the
// AnimSpriteEffect they inherit from; Engine holds Actor, and Actor is where DrawScale
// defaults to 1 (UT_ShellCase never sets one, and reading it as 0 would collapse the mesh
// to a point).
const PACKAGES = [
  ["Botpack", "BotPack.u"],
  ["UnrealShare", "UnrealShare.u"],
  ["Engine", "Engine.u"],
  ["Core", "Core.u"],
];
const pkgs = PACKAGES.map(([name, file]) => {
  const p = path.join(SYSTEM, file);
  if (!fs.existsSync(p)) {
    console.error(`no such file: ${p}`);
    console.error(`this tool needs a retail UT99 install; pass the System directory as an argument.`);
    process.exit(1);
  }
  return { name, pkg: loadPackage(fs.readFileSync(p)) };
});

/** The one class export with this name, in whichever package has it. */
function findClass(name) {
  for (const { name: pn, pkg: p } of pkgs) {
    try {
      return { pkgName: pn, pkg: p, exp: p.findClass(name) };
    } catch {
      /* not in this package */
    }
  }
  throw new Error(`${name}: no class export in ${PACKAGES.map(([, f]) => f).join(", ")}`);
}

/**
 * A class's defaults WITH everything it inherits, most-derived last.
 *
 * UE1 only serializes what a class overrides, so UT_RingExplosion5 alone reports a single
 * boolean and nothing else — every number that matters is on UT_RingExplosion above it,
 * and UT_ShellCase's DrawScale is on Engine.Actor four classes up.
 */
function inheritedDefaults(name) {
  const chain = [];
  const seen = new Set();
  for (let n = name; n && !seen.has(n); ) {
    seen.add(n);
    const f = findClass(n);
    chain.push(f);
    n = f.pkg.resolve(f.exp.super);
  }
  const out = {};
  for (let i = chain.length - 1; i >= 0; i--) Object.assign(out, classDefaults(chain[i].pkg, chain[i].exp));
  return out;
}

/** The one mesh/texture export with this name, in whichever package has it. */
function meshPkg(name) {
  for (const { pkg: p } of pkgs) {
    try {
      readMesh(p, name);
      return p;
    } catch {
      /* not in this package */
    }
  }
  throw new Error(`${name}: no mesh export in ${PACKAGES.map(([, f]) => f).join(", ")}`);
}
function texturePkg(name) {
  for (const { pkg: p } of pkgs) {
    if (p.exports.some((e) => e.name === name && /Texture/.test(p.classOf(e) || ""))) return p;
  }
  throw new Error(`${name}: no Texture export in ${PACKAGES.map(([, f]) => f).join(", ")}`);
}

/** A UE1 rotator component (65536 to the turn) as degrees, and as radians per second. */
const rotDeg = (units) => (units * 360) / 65536;
const rotRad = (units) => (units * 2 * Math.PI) / 65536;
const r4 = (n) => Math.round(n * 10000) / 10000;
const r6 = (n) => Math.round(n * 1e6) / 1e6;

/** An FVector or FRotator property, which readProperties hands back as raw struct bytes. */
function triple(v) {
  if (!v || !v.bytes) return null;
  const b = Buffer.from(v.bytes.data || v.bytes);
  return b.length >= 12 ? [b.readFloatLE(0), b.readFloatLE(4), b.readFloatLE(8)] : null;
}
/** A rotator property, as its three INT components (pitch, yaw, roll). */
function rotator(v) {
  if (!v || !v.bytes) return null;
  const b = Buffer.from(v.bytes.data || v.bytes);
  return b.length >= 12 ? [b.readInt32LE(0), b.readInt32LE(4), b.readInt32LE(8)] : null;
}

// ---------------------------------------------------------------------------
// THE MESH -> SCENE TRANSFORM
// ---------------------------------------------------------------------------

/**
 * UE1's FRotationMatrix for a rotator, in degrees. Rows are the rotated frame's axes.
 *
 * Identical to the one in build-ut-viewmodels.mjs and build-ut-characters.mjs, and kept
 * in the row form for the same reason: row i dotted with a mesh-frame vector gives its
 * component along parent axis i, so M^T takes mesh components to actor components.
 */
function rotationMatrix(pitchDeg, yawDeg, rollDeg) {
  const d = (a) => (a * Math.PI) / 180;
  const [sp, cp] = [Math.sin(d(pitchDeg)), Math.cos(d(pitchDeg))];
  const [sy, cy] = [Math.sin(d(yawDeg)), Math.cos(d(yawDeg))];
  const [sr, cr] = [Math.sin(d(rollDeg)), Math.cos(d(rollDeg))];
  return [
    [cp * cy, cp * sy, sp],
    [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, -sr * cp],
    [-(cr * sp * cy + sr * sy), cy * sr - cr * sp * sy, cr * cp],
  ];
}

const transpose = (m) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => m[j][i]));
const matMul = (a, b) =>
  a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const apply = (m, v) => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
const det3 = (m) =>
  m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
  m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
  m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

// UT axes (x forward, y right, z up) -> the SCENE axes the map is drawn in, which
// src/shared/map-transform.js's uuToScene writes as scene = (UT.x, UT.z, UT.y). Not the
// view models' UT_TO_VIEW and not the characters' UT_TO_WORLD: both of those additionally
// yaw the model round so that "forward" lands on -Z, which is right for something the
// client draws unrotated and wrong for something the client places in the world.
// Determinant -1 — a single swap of two axes — so winding reverses.
const UT_TO_SCENE = [
  [1, 0, 0],
  [0, 0, 1],
  [0, 1, 0],
];

/**
 * The full mesh-local -> scene matrix for one mesh at one DrawScale.
 *
 * Mesh.Origin is NOT in here: it is subtracted from the raw vertex before this is applied,
 * because UE1 subtracts it in unscaled units (see the header, and build-ut-characters.mjs
 * which measured it on eight pawns).
 */
function sceneMatrix(mesh, drawScale) {
  const k = UU_TO_M * drawScale;
  const scale = [
    [mesh.scale[0] * k, 0, 0],
    [0, mesh.scale[1] * k, 0],
    [0, 0, mesh.scale[2] * k],
  ];
  const [pitch, yaw, roll] = mesh.rotOrigin.map(rotDeg);
  return matMul(UT_TO_SCENE, matMul(transpose(rotationMatrix(pitch, yaw, roll)), scale));
}

/**
 * The signed volume the emitted triangles enclose, as glTF reads them.
 *
 * glTF front faces are counter-clockwise seen from outside, so a closed mesh wound that
 * way has positive signed volume about an interior point. Unlike the weapons and the
 * bodies, TWO OF THESE FOUR ARE NOT CLOSED — UTRingex is a flat annulus with no thickness
 * at all, so both windings give a volume of zero and the test cannot decide. So the
 * winding is taken from the DETERMINANT, which is exact, and the volume is used only as a
 * corroboration where it is decisive: it has to agree, or the build stops.
 */
function signedVolume(positions, indices) {
  const n = positions.length / 3;
  const centre = [0, 0, 0];
  for (let i = 0; i < positions.length; i += 3) {
    centre[0] += positions[i] / n;
    centre[1] += positions[i + 1] / n;
    centre[2] += positions[i + 2] / n;
  }
  let v = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((j) => {
      const o = indices[i + j] * 3;
      return [positions[o] - centre[0], positions[o + 1] - centre[1], positions[o + 2] - centre[2]];
    });
    v +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return v;
}

// ---------------------------------------------------------------------------
// WHAT GETS BUILT
// ---------------------------------------------------------------------------
// `actor` is the class whose DrawScale, Style and bUnlit the model is built at, so the
// committed glTF is the size and the blend UT99 spawns it at. The Sniper Rifle's shell
// case is the one instance that overrides its own DrawScale (to 2.0, in the weapon's
// ProcessTraceHit) and the manifest carries that as a multiplier.
//
// `clip` names a sequence to emit as a morph animation, exactly as the view models do —
// base pose is its first frame, one morph target per later frame, one-hot weights, LINEAR
// (UE1 interpolates between vertex frames; that is what AnimFrame's fraction is).
const MODELS = [
  { id: "shockbeam", mesh: "Shockbm", actor: "ShockBeam" },
  { id: "ring", mesh: "UTRingex", actor: "UT_RingExplosion5", clip: "Explo" },
  { id: "bulletimpact", mesh: "BulletImpact", actor: "BulletImpact" },
  { id: "shellcase", mesh: "Shellc", actor: "UT_ShellCase" },
];

// The flat images: sprites and decals that are never geometry. Sizes are worked out in the
// manifest from USize * DrawScale (see the sprite note there), so only the frames are here.
//
// UT_SpriteSmokePuff picks one of FOUR sets at random per puff (SSprites[Rand(NumSets)]),
// and each set is a DT_SpriteAnimOnce chain: us1_a00 -> us1_a01 -> ... UE1 walks that
// chain through the texture's own AnimNext link. The class declares NumFrames = 8, and
// that is what is composed here; the chain in the package actually runs to a14, which is
// recorded in the manifest as a fact rather than acted on.
const SMOKE_FRAMES = 8;

/** Extract one texture to assets/3d/effects/fx/<file>. */
function extractFx(name, file, { masked = false } = {}) {
  const img = readTexture(texturePkg(name), name, { masked });
  const rgba = Buffer.from(img.rgba.buffer, img.rgba.byteOffset, img.rgba.length);
  fs.mkdirSync(FX_DIR, { recursive: true });
  fs.writeFileSync(path.join(FX_DIR, file), writePng(img.width, img.height, rgba));
  return { path: `assets/3d/effects/fx/${file}`, size: [img.width, img.height] };
}

/** Compose an N-frame sprite chain onto one strip, frames left to right. */
function extractSheet(names, file) {
  const imgs = names.map((n) => readTexture(texturePkg(n), n));
  const w = imgs[0].width;
  const h = imgs[0].height;
  for (const [i, img] of imgs.entries()) {
    if (img.width !== w || img.height !== h) {
      throw new Error(`${file}: frame ${names[i]} is ${img.width}x${img.height}, not ${w}x${h}`);
    }
  }
  const sheet = Buffer.alloc(imgs.length * w * h * 4);
  imgs.forEach((img, i) => {
    for (let y = 0; y < h; y++) {
      const src = Buffer.from(img.rgba.buffer, img.rgba.byteOffset, img.rgba.length);
      src.copy(sheet, (y * imgs.length * w + i * w) * 4, y * w * 4, (y + 1) * w * 4);
    }
  });
  fs.mkdirSync(FX_DIR, { recursive: true });
  fs.writeFileSync(path.join(FX_DIR, file), writePng(imgs.length * w, h, sheet));
  return { path: `assets/3d/effects/fx/${file}`, frames: imgs.length, frameSize: [w, h] };
}

// ---------------------------------------------------------------------------
// BUILD: the meshes
// ---------------------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true });
const models = {};

for (const spec of MODELS) {
  const d = inheritedDefaults(spec.actor);
  const drawScale = d.DrawScale ?? 1;
  if (!(drawScale > 0)) throw new Error(`${spec.id}: ${spec.actor} DrawScale is ${drawScale}`);
  const dir = path.join(OUT_DIR, spec.id);
  fs.mkdirSync(dir, { recursive: true });
  models[spec.id] = buildModel(spec, d, drawScale, dir);
}

/** One mesh -> one glTF + .bin + its PNGs, in the scene frame, with a morph clip if asked. */
function buildModel(spec, d, drawScale, dir) {
  const pkg = meshPkg(spec.mesh);
  const mesh = readMesh(pkg, spec.mesh);
  const M = sceneMatrix(mesh, drawScale);
  const O = mesh.origin;

  // The clip, if any, and the base pose. For a one-frame mesh that is frame 0; for the
  // ring it is the first frame of 'Explo', which is also frame 0 — but it is looked up
  // through the sequence rather than assumed, because "frame 0 is the rest pose" is
  // exactly the assumption that put six view models mid-swing.
  const seq = spec.clip ? mesh.anims.find((a) => a.name === spec.clip) : null;
  if (spec.clip && !seq) {
    throw new Error(
      `${spec.mesh}: no sequence "${spec.clip}" — has ${mesh.anims.map((a) => a.name).join(", ")}`,
    );
  }
  if (seq && !(seq.rate > 0)) throw new Error(`${spec.mesh}.${spec.clip}: rate is ${seq.rate}`);
  const baseFrame = seq ? seq.startFrame : 0;

  // `specialVerts` of every frame are UT's weapon anchors rather than geometry; none of
  // these four has any, but the slice is what every other extractor here does and leaving
  // it out would be a silent difference rather than a decision.
  const framePos = (f) =>
    mesh
      .frame(f)
      .slice(mesh.specialVerts)
      .map((v) => apply(M, [v[0] - O[0], v[1] - O[1], v[2] - O[2]]));
  const basePos = framePos(baseFrame);

  // Wedges are per-corner already (a vertex index plus a UV), so they map one to one onto
  // glTF vertices and nothing needs splitting.
  const positions = [];
  const uvs = [];
  for (const w of mesh.wedges) {
    const p = basePos[w.v];
    if (!p) throw new Error(`${spec.id}: wedge points at vertex ${w.v} of ${basePos.length}`);
    positions.push(...p);
    uvs.push(w.u / 256, w.vv / 256);
  }

  // --- winding -----------------------------------------------------------
  // From the determinant, which is exact; corroborated by signed volume where the mesh is
  // closed enough for the two orders to disagree at all. UTRingex is a flat annulus and
  // gives ~0 either way, which is a legitimate "no opinion" rather than a failure.
  const groups = new Map();
  for (const f of mesh.faces) {
    if (!groups.has(f.material)) groups.set(f.material, []);
    groups.get(f.material).push(...f.w);
  }
  const flat = [...groups.values()].flat();
  const flip = det3(M) < 0;
  const asIs = signedVolume(positions, flat);
  const reversed = signedVolume(
    positions,
    flat.map((_, i, a) => a[i - (i % 3) + [0, 2, 1][i % 3]]),
  );
  // "Decisive" means the two orders differ by more than a thousandth of the mesh's own
  // bounding box volume — below that the mesh is a sheet and has no inside.
  const box = [0, 1, 2].map(
    (a) => Math.max(...basePos.map((p) => p[a])) - Math.min(...basePos.map((p) => p[a])),
  );
  const decisive = Math.abs(asIs - reversed) > 1e-3 * Math.max(1e-9, box[0] * box[1] * box[2]);
  if (decisive && reversed > asIs !== flip) {
    throw new Error(
      `${spec.id}: winding disagrees with the transform's determinant ` +
        `(det ${det3(M)}, volumes ${asIs} / ${reversed})`,
    );
  }
  const order = flip ? [0, 2, 1] : [0, 1, 2];

  // --- buffer ------------------------------------------------------------
  const parts = [];
  const bufferViews = [];
  const accessors = [];
  let offset = 0;
  const pad = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
  const push = (buf, target) => {
    parts.push(pad(buf));
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}) });
    offset += pad(buf).length;
    return bufferViews.length - 1;
  };
  const minMax = (arr, n) => {
    const min = Array(n).fill(Infinity);
    const max = Array(n).fill(-Infinity);
    for (let i = 0; i < arr.length; i += n) {
      for (let j = 0; j < n; j++) {
        if (arr[i + j] < min[j]) min[j] = arr[i + j];
        if (arr[i + j] > max[j]) max[j] = arr[i + j];
      }
    }
    return { min, max };
  };

  const pos = minMax(positions, 3);
  const POSITION = accessors.length;
  accessors.push({
    bufferView: push(Buffer.from(new Float32Array(positions).buffer), 34962),
    componentType: 5126,
    count: positions.length / 3,
    type: "VEC3",
    min: pos.min,
    max: pos.max,
  });
  const TEXCOORD = accessors.length;
  accessors.push({
    bufferView: push(Buffer.from(new Float32Array(uvs).buffer), 34962),
    componentType: 5126,
    count: uvs.length / 2,
    type: "VEC2",
  });

  // --- morph targets: one per frame after the base, as POSITION deltas ---
  const frames = [];
  if (seq) for (let i = 1; i < seq.numFrames; i++) frames.push(seq.startFrame + i);
  const targets = [];
  for (const f of frames) {
    const fp = framePos(f);
    const delta = new Float32Array(mesh.wedges.length * 3);
    mesh.wedges.forEach((w, i) => {
      for (let a = 0; a < 3; a++) delta[i * 3 + a] = fp[w.v][a] - basePos[w.v][a];
    });
    const mm = minMax(delta, 3);
    targets.push({ POSITION: accessors.length });
    accessors.push({
      bufferView: push(Buffer.from(delta.buffer), 34962),
      componentType: 5126,
      count: mesh.wedges.length,
      type: "VEC3",
      min: mm.min,
      max: mm.max,
    });
  }

  // --- materials and primitives -----------------------------------------
  const primitives = [];
  const materials = [];
  const images = [];
  const textures = [];
  const pngFor = new Map(); // texture name -> file
  const texIndex = new Map(); // texture name -> this glTF's texture index
  for (const [matIndex, wedgeIdx] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const mat = mesh.materials[matIndex];
    const texName = mesh.textures[mat.textureIndex];
    if (!texName) throw new Error(`${spec.id}: material ${matIndex} has no texture`);
    const flags = mat.polyFlags;
    if (!pngFor.has(texName)) {
      const file = `s${pngFor.size}.png`;
      const img = readTexture(pkg, texName, { masked: (flags & PF_MASKED) !== 0 });
      const rgba = Buffer.from(img.rgba.buffer, img.rgba.byteOffset, img.rgba.length);
      fs.writeFileSync(path.join(dir, file), writePng(img.width, img.height, rgba));
      pngFor.set(texName, file);
    }
    if (!texIndex.has(texName)) {
      images.push({ uri: pngFor.get(texName) });
      textures.push({ source: images.length - 1, sampler: 0 });
      texIndex.set(texName, textures.length - 1);
    }

    const material = {
      name: `slot${materials.length}`,
      doubleSided: (flags & PF_TWOSIDED) !== 0,
      pbrMetallicRoughness: {
        baseColorTexture: { index: texIndex.get(texName) },
        metallicFactor: 0,
        roughnessFactor: 1,
      },
    };
    // TWO separate things say "translucent" and both matter, exactly as the projectiles
    // build found for bUnlit: the polygon group's PF_Translucent (the ring has it) and the
    // ACTOR's Style (the beam and the bullet impact have STY_Translucent with polyflags of
    // zero). Honouring only the polygon flag draws the beam as an opaque black tube.
    if (flags & PF_TRANSLUCENT || d.Style === STY_TRANSLUCENT) material.alphaMode = "BLEND";
    else if (flags & PF_MASKED) material.alphaMode = "MASK";
    // Same for unlit: PF_Unlit on the polygons, bUnlit on the actor. Every one of these
    // four actors is bUnlit — an impact flash is self-lit, and this level is a night sky.
    if (flags & PF_UNLIT || d.bUnlit === true) material.extensions = { KHR_materials_unlit: {} };

    const indices = [];
    for (let i = 0; i < wedgeIdx.length; i += 3) for (const o of order) indices.push(wedgeIdx[i + o]);
    primitives.push({
      attributes: { POSITION, TEXCOORD_0: TEXCOORD },
      indices: accessors.length,
      material: materials.length,
      // Every primitive carries the same targets; the glTF spec and three.js both require
      // the count to match across a mesh's primitives.
      ...(targets.length ? { targets } : {}),
    });
    accessors.push({
      bufferView: push(Buffer.from(new Uint16Array(indices).buffer), 34963),
      componentType: 5123,
      count: indices.length,
      type: "SCALAR",
    });
    materials.push(material);
  }

  // --- the animation ------------------------------------------------------
  // Keyframe i sits at i / seq.rate seconds, where seq.rate is the sequence's own authored
  // fps. What UnrealScript passes to PlayAnim is a MULTIPLIER on that, and it rides in the
  // manifest instead of being baked in — the same split the view models make, and for the
  // same reason: bake it and nobody can reuse the clip at another speed.
  const animations = [];
  let clipInfo = null;
  if (seq) {
    const keys = [];
    const weights = [];
    for (let i = 0; i < seq.numFrames; i++) {
      keys.push(i / seq.rate);
      const row = new Array(targets.length).fill(0);
      if (i > 0) row[i - 1] = 1;
      weights.push(...row);
    }
    const input = accessors.length;
    accessors.push({
      bufferView: push(Buffer.from(new Float32Array(keys).buffer)),
      componentType: 5126,
      count: keys.length,
      type: "SCALAR",
      min: [keys[0]],
      max: [keys[keys.length - 1]],
    });
    const output = accessors.length;
    accessors.push({
      bufferView: push(Buffer.from(new Float32Array(weights).buffer)),
      componentType: 5126,
      count: weights.length,
      type: "SCALAR",
    });
    animations.push({
      name: seq.name,
      samplers: [{ input, output, interpolation: "LINEAR" }],
      channels: [{ sampler: 0, target: { node: 0, path: "weights" } }],
    });
    clipInfo = {
      clip: seq.name,
      startFrame: seq.startFrame,
      numFrames: seq.numFrames,
      fps: r4(seq.rate),
      // No wrap key: 'Explo' is played once by PlayAnim and the actor is destroyed, so
      // there is no loop to arrive back at.
      loop: false,
    };
  }

  const bin = Buffer.concat(parts);
  fs.writeFileSync(path.join(dir, `${spec.id}.bin`), bin);

  const min = [0, 1, 2].map((a) => Math.min(...basePos.map((p) => p[a])));
  const max = [0, 1, 2].map((a) => Math.max(...basePos.map((p) => p[a])));
  // The size at FULL EXTENT, over every frame the clip touches — for the ring the base
  // pose is a 0.37 m ring and the last frame is a 4.7 m one, and a test that only knew
  // the base would be checking the wrong thing.
  const allFrames = [basePos, ...frames.map(framePos)];
  const extMin = [0, 1, 2].map((a) => Math.min(...allFrames.flat().map((p) => p[a])));
  const extMax = [0, 1, 2].map((a) => Math.max(...allFrames.flat().map((p) => p[a])));

  const usedUnlit = materials.some((m) => m.extensions?.KHR_materials_unlit);
  const [pitch, yaw, roll] = mesh.rotOrigin.map(rotDeg);
  const gltf = {
    asset: { version: "2.0", generator: "build-ut-effects.mjs" },
    ...(usedUnlit ? { extensionsUsed: ["KHR_materials_unlit"] } : {}),
    extras: {
      utMesh: spec.mesh,
      utActor: spec.actor,
      drawScale,
      baseFrame,
      sceneFrame: "actor forward +X, up +Y, right +Z (map-transform's uuToScene axes); RotOrigin baked in",
      epicRotOriginDeg: [r4(pitch), r4(yaw), r4(roll)],
      meshOriginUU: mesh.origin.map(r4),
      ...(clipInfo ? { clip: clipInfo } : {}),
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: spec.id }],
    meshes: [
      { name: spec.id, primitives, ...(targets.length ? { weights: new Array(targets.length).fill(0) } : {}) },
    ],
    materials,
    textures,
    images,
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    accessors,
    bufferViews,
    buffers: [{ uri: `${spec.id}.bin`, byteLength: bin.length }],
    ...(animations.length ? { animations } : {}),
  };
  fs.writeFileSync(path.join(dir, `${spec.id}.gltf`), JSON.stringify(gltf, null, 1) + "\n");

  console.log(
    `${spec.id.padEnd(13)} ${spec.mesh.padEnd(13)} ${String(mesh.faces.length).padStart(3)} faces, ` +
      `${materials.length} mat, ${targets.length} morph  ` +
      `${[0, 1, 2].map((a) => (extMax[a] - extMin[a]).toFixed(3)).join(" x ")} m   ` +
      `DrawScale ${drawScale}  bin ${(bin.length / 1024).toFixed(0)}K`,
  );

  return {
    model: `assets/3d/effects/${spec.id}/${spec.id}.gltf`,
    mesh: spec.mesh,
    actor: spec.actor,
    drawScale: r6(drawScale),
    // Already multiplied into the geometry above. Kept so that a reader can tell whether a
    // number in this file has been applied or is still waiting to be.
    drawScaleApplied: true,
    style: d.Style ?? null,
    bUnlit: d.bUnlit === true,
    bParticles: d.bParticles === true,
    unlitMaterials: usedUnlit,
    faces: mesh.faces.length,
    verts: mesh.frameVerts,
    bboxM: { min: min.map(r4), max: max.map(r4) },
    sizeM: [0, 1, 2].map((a) => r4(max[a] - min[a])),
    extentM: [0, 1, 2].map((a) => r4(extMax[a] - extMin[a])),
    ...(clipInfo ? { clip: clipInfo } : {}),
    // The particle reading, for the one actor that has bParticles set. See the header:
    // UE1 draws these vertices as sprites of the actor's Texture and never draws the
    // triangles at all, so the points are the honest geometry and the tube is a courtesy.
    ...(d.bParticles === true
      ? {
          particles: {
            texture: d.Texture ?? null,
            count: basePos.length,
            pointsM: basePos.map((p) => p.map(r4)),
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// BUILD: the flat images
// ---------------------------------------------------------------------------

// UT_SpriteSmokePuff.SSprites, read off the class rather than typed: us1_a00, us2_a00,
// US3_A00, us8_a00 (Epic's own inconsistent casing, and it matters here because the
// package's export names are what utex looks up).
const smokeDefaults = inheritedDefaults("UT_SpriteSmokePuff");
const smokeSets = (Array.isArray(smokeDefaults.SSprites) ? smokeDefaults.SSprites : []).filter(
  (n) => typeof n === "string",
);
if (smokeSets.length !== (smokeDefaults.NumSets ?? 0)) {
  throw new Error(
    `UT_SpriteSmokePuff: SSprites has ${smokeSets.length} entries but NumSets is ${smokeDefaults.NumSets}`,
  );
}
const smokeFrames = smokeDefaults.NumFrames ?? SMOKE_FRAMES;

/**
 * The full DT_SpriteAnimOnce chain a starting texture links to.
 *
 * A UE1 texture carries an AnimNext object reference, and that link — not any count on
 * the actor — is what the engine walks to play a sprite animation. Reading it is the only
 * way to know how many frames actually exist, which is how the NumFrames disagreement in
 * the manifest was found rather than assumed away.
 */
function animChain(first) {
  const out = [first];
  const pkg = texturePkg(first);
  for (let n = first; ; ) {
    const exp = pkg.exports.find((e) => e.name === n && /Texture/.test(pkg.classOf(e) || ""));
    if (!exp) break;
    // The same two lines utex.mjs opens with: a cursor, an end, and the tagged properties.
    const props = readProperties(pkg, { p: exp.offset }, exp.offset + exp.size);
    const next = props.AnimNext;
    if (!next || out.includes(next)) break;
    out.push(next);
    n = next;
  }
  return out;
}

const smoke = [];
smokeSets.forEach((first, i) => {
  const chain = animChain(first);
  // The class says NumFrames; the AnimNext chain in the package is longer (15 for every
  // one of these four). UT99 plays NumFrames of it, so that is what is composed, and the
  // chain length is recorded so the difference is visible rather than lost.
  const names = chain.slice(0, smokeFrames);
  if (names.length !== smokeFrames) {
    throw new Error(`${first}: chain has ${chain.length} frames, need ${smokeFrames}`);
  }
  const sheet = extractSheet(names, `smokepuff-${i + 1}.png`);
  smoke.push({ ...sheet, first, chainFrames: chain.length, names });
});

// UT_Spark is a plain DT_Sprite on one texture, named on the class.
const spark = inheritedDefaults("UT_Spark");
if (!spark.Texture) throw new Error("UT_Spark has no Texture");
const sparky = extractFx(spark.Texture, "sparky.png");
// Pock picks one of three at random in PostBeginPlay; all three are extracted because
// "one of three" is the effect.
const pockDefaults = inheritedDefaults("Pock");
const pockTex = (Array.isArray(pockDefaults.PockTex) ? pockDefaults.PockTex : []).filter(
  (n) => typeof n === "string",
);
if (!pockTex.length) throw new Error("Pock has no PockTex array");
const pocks = pockTex.map((n, i) => ({ texture: n, ...extractFx(n, `pock-${i}.png`) }));

// ---------------------------------------------------------------------------
// THE MANIFEST
// ---------------------------------------------------------------------------

const beam = inheritedDefaults("ShockBeam");
const ring = inheritedDefaults("UT_RingExplosion5");
const impact = inheritedDefaults("BulletImpact");
const chip = inheritedDefaults("Chip");
const shell = inheritedDefaults("UT_ShellCase");
const shockExplo = inheritedDefaults("ShockExplo");
const zone = inheritedDefaults("ZoneInfo");

// BulletImpact.PostBeginPlay: PlayAnim('Hit', 0.5). The rate is a MULTIPLIER on the
// sequence's own authored fps, which is read off the mesh beside it.
const IMPACT_ANIM_RATE = 0.5;
const impactMesh = readMesh(meshPkg(impact.Mesh), impact.Mesh);
const hitSeq = impactMesh.anims.find((a) => a.name.toLowerCase() === (impact.AnimSequence || "Hit").toLowerCase());
if (!hitSeq || !(hitSeq.rate > 0)) {
  throw new Error(`${impact.Mesh}: no usable '${impact.AnimSequence}' sequence to time the flash by`);
}

const beamRot = rotator(beam.RotationRate) || [0, 0, 0];
const beamStart = rotator(beam.Rotation) || [0, 0, 0];

/**
 * The world size, in Unreal Units, of a UE1 sprite.
 *
 * A DT_Sprite / DT_SpriteAnimOnce actor is drawn as a camera-facing quad whose extent is
 * the TEXTURE'S OWN PIXEL SIZE times DrawScale, in Unreal Units — one texel per unit at
 * DrawScale 1. That is not a guess made here: it is the same relation gen-weapons.mjs
 * already uses for the projectile explosions (`size: uu(frameSize * drawScale)`), which
 * were fitted against the real thing, and it is what UE1's own DrawActorSprite does — it
 * takes Texture->USize * Actor->DrawScale into world space and lets the projection divide.
 *
 * So a 32x32 smoke puff at DrawScale 2 is 64 UU = 1.50 m across, and a 32x32 spark at
 * DrawScale 0.1 is 3.2 UU = 7.5 cm. Both read right for what they are.
 */
const spriteM = (texelSize, drawScale) => r4(texelSize * drawScale * UU_TO_M);
const uuM = (n) => r6(n * UU_TO_M);

const manifest = {
  $comment: [
    "UT99 impact effects: the shock beam and its ring, the bullet wall hit, its smoke,",
    "sparks, chips and decal, and the ejected shell case.",
    "GENERATED by scripts/build-ut-effects.mjs from a retail install — do not hand-edit.",
    "",
    "Geometry is emitted in the SCENE frame the map uses (src/shared/map-transform.js's",
    "uuToScene: scene = UT.x, UT.z, UT.y), so an actor's forward is +X and up is +Y.",
    "Every one of these is spawned with Rotator(HitNormal) or rotator(fireDirection), so",
    "aligning model +X with that vector is the whole of the placement.",
    "",
    "Each model's DrawScale is ALREADY BAKED INTO ITS VERTICES (drawScaleApplied), so the",
    "committed glTF is the size UT99 spawns it at. drawScale is kept for reference and for",
    "the one instance that overrides it: the Sniper Rifle sets its shell case to 2.0.",
    "",
    "Lengths are Unreal Units unless the key says M; scripts/gen-effects.mjs converts.",
  ],
  source: "UT99 retail",
  models,

  // --- the Shock Rifle's beam -------------------------------------------
  shockBeam: {
    actor: "ShockBeam",
    lifeSpan: r6(beam.LifeSpan),
    drawScale: r6(beam.DrawScale),
    // ShockRifle.SpawnEffect: NumPoints = VSize(HitLocation - Start)/135.0, and each
    // segment spawns the next at Location + DVector/NumPoints. So 135 UU is the SPACING,
    // and the beam's segments do not touch: Shockbm is 73.7 UU long at DrawScale 0.44.
    spacingUU: 135,
    // ShockBeam.PostBeginPlay sets a one-shot 0.05 s timer, and its Timer() spawns the
    // next segment. The beam therefore reaches a 30 m target in about 0.45 s.
    segmentIntervalS: 0.05,
    // The muzzle end: ShockRifle.ProcessTraceHit passes
    // Owner.Location + CalcDrawOffset() + (FireOffset.X + 20)*X + FireOffset.Y*Y + FireOffset.Z*Z
    muzzleForwardBonusUU: 20,
    // RotationRate.Roll with bFixedRotationDir: a constant spin about the beam's own axis.
    // 65536 rotator units to the turn.
    rollRateUU: beamRot[2],
    rollRateRadPerSec: r6(rotRad(beamRot[2])),
    // SmokeRotation.roll = Rand(65535) at spawn — every beam is rolled randomly, which is
    // what stops a chain of identical segments from looking like one extruded tube.
    startRollUU: beamStart[2],
    randomStartRoll: true,
    // Tick: ScaleGlow = (Lifespan/Default.Lifespan)*1.0; AmbientGlow = ScaleGlow*210.
    scaleGlowMax: 1,
    ambientGlowMax: beam.AmbientGlow ?? 210,
    glowMax: r6(210 / 255),
    style: beam.Style,
    bUnlit: beam.bUnlit === true,
    // See the header: this is what UE1 actually draws.
    bParticles: beam.bParticles === true,
    particleTexture: beam.Texture,
    particleSizeM: spriteM(readTexture(texturePkg(beam.Texture), beam.Texture).width, beam.DrawScale),
  },

  // --- the Shock Rifle's hit --------------------------------------------
  shockRing: {
    actor: "UT_RingExplosion5",
    lifeSpan: r6(ring.LifeSpan),
    drawScale: r6(ring.DrawScale),
    // PlayAnim('Explo', 0.35, 0.0) — a rate MULTIPLIER on the sequence's own 30 fps.
    animRate: 0.35,
    // Spawn(class'ut_RingExplosion5',,, HitLocation+HitNormal*8, rotator(HitNormal))
    offsetAlongNormalUU: 8,
    // Tick: ScaleGlow = (Lifespan/Default.Lifespan)*0.7; AmbientGlow = ScaleGlow*255.
    scaleGlowMax: 0.7,
    glowMax: 0.7,
    style: ring.Style,
    bUnlit: ring.bUnlit === true,
    // The two actors the ring spawns that this build does NOT model, named so the omission
    // is a decision rather than an oversight. ShockExplo is a 15-frame sprite blast with a
    // blue point light; EnergyImpact is a scorch decal on shockmark.
    alsoSpawns: [
      {
        actor: "ShockExplo",
        what: "DT_SpriteAnimOnce blast",
        firstFrame: shockExplo.Texture,
        numFrames: shockExplo.NumFrames,
        pause: r6(shockExplo.Pause),
        lifeSpan: r6(shockExplo.LifeSpan),
        drawScale: r6(shockExplo.DrawScale ?? 1),
        sound: shockExplo.EffectSound1 ?? null,
      },
      { actor: "EnergyImpact", what: "scorch decal", texture: "shockmark" },
    ],
  },

  // --- the bullet's flash ------------------------------------------------
  bulletImpact: {
    actor: "BulletImpact",
    // NO LifeSpan of its own: BulletImpact.AnimEnd calls Destroy(). Its life is therefore
    // the length of PlayAnim('Hit', 0.5), and UE1's PlayAnim sets
    // AnimRate = Rate * Seq->Rate / Seq->NumFrames with AnimFrame running 0 -> 1, so a
    // sequence lasts NumFrames / (Seq.Rate * Rate) seconds. Read off the mesh, not typed,
    // and cross-checked in the header against the ring, which has both an animation and a
    // declared LifeSpan (0.857 s of 'Explo' inside a 0.800 s life).
    lifeSpan: r6(hitSeq.numFrames / (hitSeq.rate * IMPACT_ANIM_RATE)),
    lifeSpanFrom: `AnimEnd of '${hitSeq.name}' (${hitSeq.numFrames} frame at ${hitSeq.rate} fps, PlayAnim rate ${IMPACT_ANIM_RATE})`,
    animRate: IMPACT_ANIM_RATE,
    drawScale: r6(impact.DrawScale),
    ambientGlow: impact.AmbientGlow ?? 255,
    style: impact.Style,
    bUnlit: impact.bUnlit === true,
    // Spawn(...,, HitLocation+HitNormal, Rotator(HitNormal)) — one unit off the wall.
    offsetAlongNormalUU: 1,
  },

  // --- the smoke -------------------------------------------------------
  smokePuff: {
    actor: "UT_SpriteSmokePuff",
    sets: smoke.map((s) => ({ path: s.path, first: s.first, frames: s.frames, chainFrames: s.chainFrames })),
    frames: smokeFrames,
    pause: r6(smokeDefaults.Pause),
    lifeSpan: r6(smokeDefaults.LifeSpan),
    drawScale: r6(smokeDefaults.DrawScale),
    scaleGlow: r6(smokeDefaults.ScaleGlow),
    // BeginPlay: Velocity = Vect(0,0,1)*RisingRate, and Physics is PHYS_Rotating (6), so
    // it drifts straight up and gravity never touches it.
    risingRateUU: smokeDefaults.RisingRate,
    frameSize: smoke[0].frameSize,
    sizeM: spriteM(smoke[0].frameSize[0], smokeDefaults.DrawScale),
    style: smokeDefaults.Style,
    // The three places a smoke puff is spawned, all read off the call sites:
    //   UT_WallHit             at the wall hit's own location (already HitNormal*1 out)
    //   UT_HeavyWallHitEffect  Location + 8 * Vector(Rotation)
    //   enforcer/sniper on a non-pawn actor hit   HitLocation + HitNormal*9
    offsetAlongNormalUU: { wallHit: 0, heavyWallHit: 8, objectHit: 9 },
    // 8 frames at 0.05 s is 0.40 s of animation inside a 1.50 s life: the puff forms fast
    // and then drifts on its last frame. That is Epic's, not a rounding.
    animSeconds: r6(smokeFrames * (smokeDefaults.Pause ?? 0.05)),
  },

  // --- the sparks -------------------------------------------------------
  spark: {
    actor: "UT_Spark",
    texture: sparky.path,
    frameSize: sparky.size,
    lifeSpan: r6(spark.LifeSpan),
    drawScale: r6(spark.DrawScale),
    sizeM: spriteM(sparky.size[0], spark.DrawScale),
    // PostBeginPlay: Velocity = (Vector(Rotation) + VRand()) * 200 * FRand()
    // — a cone about the surface normal, at a speed uniform in [0, 200] UU/s.
    speedMaxUU: 200,
    spread: "Vector(Rotation) + VRand(), normalised by nothing — a wide cone about the normal",
    // PHYS_Falling with bBounce, but Landed and HitWall both Destroy(), so in practice a
    // spark never bounces: it flies, falls and dies on the first thing it touches.
    physics: "falling",
    bounces: false,
    diesOnContact: true,
    gravityUU: (triple(zone.ZoneGravity) || [0, 0, -950])[2],
    // Spawned at Location + 8 * Vector(Rotation) by both wall-hit classes.
    offsetAlongNormalUU: 8,
    style: spark.Style,
  },

  // --- the chips --------------------------------------------------------
  chip: {
    actor: "Chip",
    mesh: chip.Mesh,
    lifeSpan: r6(chip.LifeSpan),
    // BeginState: Velocity = VRand()*200*FRand() + Vector(Rotation)*250, DrawScale is
    // randomised to FRand()*0.4 + 0.3, and the spin is +/-200000 rotator units a second on
    // all three axes. It bounces once, halving speed, then usually stops.
    launchAlongNormalUU: 250,
    scatterMaxUU: 200,
    drawScaleRange: [0.3, 0.7],
    spinMaxUU: 200000,
    physics: "falling",
    bounces: true,
    note: "no glTF is built for the chip: it is a 6-face pebble and the client can stand in for it",
  },

  // --- the decal --------------------------------------------------------
  pock: {
    actor: "Pock",
    textures: pocks,
    drawScale: r6(pockDefaults.DrawScale),
    sizeM: spriteM(pocks[0].size[0], pockDefaults.DrawScale),
    // AttachToSurface: AttachDecal(100, vect(0,0,1)) — traced 100 UU along the actor's
    // rotation, which is the surface normal it was spawned with.
    traceUU: 100,
    // Decal is native and stores no Style. UE1 projects a decal modulated, i.e. it
    // darkens what is under it rather than adding to it — which is what a bullet pock in
    // UT99 looks like, and the opposite of every other effect in this file.
    blend: "modulate",
    lifeSeconds: [18, 23],
    lifeFrom: "Scorch.Timer: SetTimer(18.0 + 5 * FRand()) once attached",
  },

  // --- the shell case ---------------------------------------------------
  shellCase: {
    actor: "UT_ShellCase",
    mesh: shell.Mesh,
    lifeSpan: r6(shell.LifeSpan),
    drawScale: r6(shell.DrawScale ?? 1),
    // The Sniper Rifle sets s.DrawScale = 2.0 before ejecting. A MULTIPLIER on the model,
    // which is already at DrawScale 1.
    sniperDrawScale: 2,
    // Eject(Vel) from the weapon's ProcessTraceHit, in the shooter's own axes:
    //   ((FRand()*0.3+0.4)*X + (FRand()*0.2+0.2)*Y + (FRand()*0.3+1.0)*Z) * 160
    ejectUU: {
      forward: [r6(0.4 * 160), r6(0.7 * 160)],
      right: [r6(0.2 * 160), r6(0.4 * 160)],
      up: [r6(1.0 * 160), r6(1.3 * 160)],
    },
    // Spawn position, also in the shooter's axes. The Sniper's is further out and further
    // right because the rifle is a bigger gun held further from the body.
    spawnOffsetUU: {
      enforcer: "realLoc + 20*X + FireOffset.Y*Y + 1*Z",
      sniper: "realLoc + 30*X + (2.8*FireOffset.Y + 5)*Y - 1*Z",
    },
    // Eject also calls RandSpin(100000): a random axis at up to 100000 rotator units/s.
    spinMaxUU: 100000,
    spinMaxRadPerSec: r6(rotRad(100000)),
    physics: "falling",
    gravityUU: (triple(zone.ZoneGravity) || [0, 0, -950])[2],
    // HitWall: velocity is halved and reflected about a jittered normal; after 3 bounces,
    // or usually after the first (bBounce is cleared with probability 0.85), it stops.
    bounces: true,
    maxBounces: 3,
    bounceRestitution: 0.5,
    bounceStopChance: 0.85,
    bounceSound: "shell2",
    style: shell.Style ?? null,
    bUnlit: shell.bUnlit === true,
  },

  // --- who spawns what --------------------------------------------------
  // The three wall-hit classes, and the budgets that decide how much of a mess a shot
  // makes. NOTE that a chip spawned DECREMENTS the spark count in both classes: the
  // budgets trade against each other rather than adding up.
  wallHit: {
    enforcer: wallHitOf("UT_WallHit", { smokeOffsetUU: 0, sparksAlways: true }),
    enforcerDual: wallHitOf("UT_LightWallHitEffect", { smokeOffsetUU: 8, sparksAlways: false }),
    sniper: wallHitOf("UT_HeavyWallHitEffect", { smokeOffsetUU: 8, sparksAlways: true }),
    // UT_WallHit.SpawnSound. The heavy one is 0.50 / 0.25 / 0.25 and never silent.
    soundOdds: { ricochet: 0.25, impact1: 0.25, impact2: 0.25, silence: 0.25 },
    heavySoundOdds: { ricochet: 0.5, impact1: 0.25, impact2: 0.25, silence: 0 },
    // PlaySound(sound'ricochet',, 1.5,,1200, 0.5+FRand()) — the last argument is pitch.
    ricochetPitch: [0.5, 1.5],
  },
  // What a shot into a BODY does instead: no wall hit at all, just a sound.
  bodyHit: { sound: "ChunkHit", volume: 4 },
};

/** One wall-hit class's budgets, off its own defaults. */
function wallHitOf(cls, extra) {
  const d = inheritedDefaults(cls);
  return {
    actor: cls,
    maxSparks: d.MaxSparks ?? 0,
    maxChips: d.MaxChips ?? 0,
    chipOdds: r6(d.ChipOdds ?? 0),
    ...extra,
  };
}

fs.writeFileSync(OUT_JSON, JSON.stringify(manifest, null, 1) + "\n");
console.log(
  `\nsmoke: ${smoke.map((s) => `${s.first}x${s.frames}`).join(", ")}  (AnimNext chains run to ` +
    `${smoke[0].chainFrames}; the class plays ${smokeFrames})\n` +
    `sparky ${sparky.size.join("x")} -> ${spriteM(sparky.size[0], spark.DrawScale)} m, ` +
    `smoke puff -> ${spriteM(smoke[0].frameSize[0], smokeDefaults.DrawScale)} m, ` +
    `pock -> ${spriteM(pocks[0].size[0], pockDefaults.DrawScale)} m\n` +
    `wrote ${path.relative(ROOT, OUT_JSON)}\nNow run: node scripts/gen-effects.mjs`,
);
