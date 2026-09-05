#!/usr/bin/env node
// build-ut-viewmodels.mjs — the six FIRST-PERSON weapon meshes, out of UT99 and into glTF,
// with UT99's own fire/select/down/idle animations as morph-target clips.
//
//   node scripts/build-ut-viewmodels.mjs [path-to-UT-System]
//
// DEV TOOLING, like build-ut-projectiles.mjs: it needs a retail install, so it is not
// part of any build. It writes assets/3d/viewmodels/<id>/ and those are committed.
//
// ---------------------------------------------------------------------------
// WHAT THIS FIXES
// ---------------------------------------------------------------------------
// A picked-up weapon used to be drawn with its PICKUP mesh — the model that spins on the
// floor — at one hardcoded scale of 0.32 and one hardcoded rotation of 90 degrees. That
// was fixed once by switching to UT99's PlayerViewMesh, and the fix was HALF right: the
// meshes were correct, the placement was not. Two things were still wrong.
//
// 1. THE ROTATION WAS NEVER APPLIED, only emitted as three Euler angles for the client to
//    hand to A-Frame. Composed in the wrong order, or against a mesh that had already had
//    its axes swapped, that pointed five of the six rifles at the player's face.
//
// 2. EVERY MEASUREMENT WAS TAKEN OFF FRAME 0, and frame 0 of a UT99 view mesh is NOT the
//    resting pose. Every one of these meshes starts with its Select sequence — the weapon
//    swinging up into view from off screen — so frame 0 is the gun at an extreme, tilted
//    and displaced. Rifle2m's frame 0 measures 7.51 units along mesh X where its rest
//    pose measures 1.70; ANY conclusion drawn about "which way does the barrel point"
//    from frame 0 is a conclusion about a gun mid-swing. Everything here uses the first
//    frame of the mesh's own 'Still' sequence instead ('Idle' where there is no 'Still').
//
// The geometry is now emitted in a VIEW FRAME — barrel along -Z, up +Y, screen right +X —
// so the client draws it with no rotation at all and there is nothing left to compose
// wrongly. `rotationDeg` stays in the manifest, as [0, 0, 0], for compatibility.
//
// ---------------------------------------------------------------------------
// ORIENTATION: EPIC'S RotOrigin IS THE RULE, APPLIED AS THE INVERSE
// ---------------------------------------------------------------------------
// A mesh's RotOrigin is an FRotator (Pitch, Yaw, Roll) saying how the mesh's own frame
// sits inside the actor's. UE1 builds a matrix from it whose ROWS are the rotated frame's
// axes expressed in the parent frame (this is FRotationMatrix, and UE2/UE3 kept it
// unchanged):
//
//     [  cp*cy              cp*sy             sp    ]
//     [  sr*sp*cy - cr*sy   sr*sp*sy + cr*cy  -sr*cp ]
//     [ -(cr*sp*cy + sr*sy) cy*sr - cr*sp*sy  cr*cp  ]
//
// Vertices are stored in the MESH frame, so getting them into the actor frame is that
// matrix TRANSPOSED — M^T v, not M v. That single sentence is the whole rule, and it is
// the difference between "Epic's numbers cannot be applied uniformly" and "they can".
//
// It is not asserted, it is MEASURED, three independent ways, on all six meshes:
//
//   a. A FIRED GUN RECOILS BACKWARDS. Taking the mesh centroid at the peak of each
//      weapon's fire sequence against its Still pose, all six move along -X (backwards)
//      once M^T is applied: Enforcer -0.45, Sniper -0.69, Shock -0.90, Rocket -0.73,
//      Ripper -0.88, Redeemer -0.30. Sideways movement is under 0.2 on every one of them.
//   b. A HOLSTERED GUN DROPS. The last frame of every 'Down' sequence sits below the
//      Still pose on -Z: -2.20, -2.24, -0.99, -0.78, -1.11, -2.64. The first frame of
//      every 'Select' sequence is below the rest pose for the same reason: the weapon
//      rises into view.
//   c. THE LONG AXIS IS X. After M^T every one of the six is longest along X, which is
//      the only axis a held weapon can be longest along.
//
//      Under the un-transposed matrix (a) and (b) come out with the wrong sign and the
//      Redeemer renders upside down with its launch tube behind the player's head, which
//      is how the transpose was found: WarHead is the one mesh whose RotOrigin has a
//      pitch and a roll (22.5, 90, -87.1875) and therefore the only one that can tell the
//      two apart. The other five are yaw-only and are identical either way up to a sign
//      that (a) then pins.
//
// So there is no fitted per-mesh table here and no "Epic's rotation cannot be applied"
// caveat. There is Epic's RotOrigin, transposed, and a self-check that refuses to write
// a mesh whose Still pose is not longest along the barrel.
//
// ---------------------------------------------------------------------------
// ANIMATION
// ---------------------------------------------------------------------------
// UT99 weapons are VERTEX animated: the mesh carries every frame of every sequence as a
// full set of positions, and AnimSeqs names spans of them. That maps onto glTF morph
// targets the same way the characters do (see scripts/gen-characters.mjs): the base mesh
// is the resting pose, one morph target per frame, and one animation per clip stepping a
// one-hot weight vector through its frames.
//
// Two details are not free choices:
//
//   LINEAR, not STEP. UE1 interpolates linearly between frames (that is what the
//   AnimFrame fraction does), so a linear ramp between adjacent one-hot vectors
//   reproduces it exactly. The characters use STEP because their clips were authored to
//   look right stepped; a 10-frame recoil stepped at 15 fps judders.
//
//   THE CLIP'S OWN RATE IS ITS AUTHORED FPS, and what UnrealScript passes to
//   PlayAnim/LoopAnim is a MULTIPLIER on it, not a frame rate. So keyframe i sits at
//   i/rate seconds and the manifest carries the multiplier separately; duration is
//   numFrames / (rate * multiplier). Bake the multiplier into the keyframe times and the
//   Enforcer's idle sway runs five times too fast the moment anyone reuses the clip.
//
// The base pose is the FIRST FRAME OF 'Still' so that all-zero weights show the weapon at
// rest, and no morph target is emitted for that frame — its delta is zero by definition,
// and an all-zero weight vector already means "the base pose". Clips that reference it
// (the Shock Rifle's one-frame 'Still', the Rocket Launcher's 'Idle') therefore get a
// sampler output of zeros, which is correct rather than degenerate.
//
// ---------------------------------------------------------------------------
// WHAT IS DERIVED AND WHAT IS NOT
// ---------------------------------------------------------------------------
// GEOMETRY, SCALE, ROTATION, the CLIP LIST and every FIRING-FEEL number are Epic's, read
// out of the class defaults, the mesh's AnimSeqs, or — where a number lives in code
// rather than in defaults — out of the UnrealScript the package still ships. The one
// exception is called out where it is emitted: the Redeemer has no idle rate to read,
// because TournamentWeapon.PlayIdleAnim is empty and WarheadLauncher does not override
// it, so UT99 plays no idle animation on it at all.
//
// TEXTURES come from scripts/lib/utex.mjs, which reads UE1's palettized textures
// directly and reproduces umodel's own output byte for byte on JuRocket1; see its header.
//
// POSITION IS STILL NOT DERIVED. PlayerViewOffset is in Unreal Units, and at pawn scale
// (0.0235 m/UU) the Enforcer's (3.30, -2.00, -3.00) is about 8 cm from the eye, against
// the 0.2/-0.3/-0.5 m the game has always used. UE1 draws the view weapon through its own
// projection rather than plain world space, so that offset does not convert directly.
// What IS trustworthy is the offsets RELATIVE to each other, so they are emitted raw and
// the client maps them through a single clearly-marked constant fitted by eye.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadPackage, classDefaults, scriptText } from "./lib/upkg.mjs";
import { readMesh } from "./lib/umesh.mjs";
import { readTexture } from "./lib/utex.mjs";
import { writePng } from "./lib/png.mjs";
import { UU_TO_M } from "../src/shared/map-transform.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT_DIR = path.join(ROOT, "assets", "3d", "viewmodels");
const UT99_DIR = path.join(ROOT, "assets", "ut99");
const SYSTEM =
  process.argv[2] || path.join(os.homedir(), "Downloads", "Unreal Tournament", "System");

// UE1 PolyFlags, the ones that change how a surface draws.
const PF_MASKED = 0x00000002;
const PF_TRANSLUCENT = 0x00000004;
const PF_TWOSIDED = 0x00000100;
const PF_UNLIT = 0x00400000;

// ---------------------------------------------------------------------------
// PACKAGES
// ---------------------------------------------------------------------------
// Botpack holds the weapons and their meshes; Engine holds the classes they inherit from,
// and the shake numbers live THERE — Engine.Weapon's shakemag/shaketime/shakevert are
// 300/0.1/5 and four of the six weapons take at least one of the three unchanged.
// TournamentWeapon in between sets none of them, so reading only Botpack gives a Shock
// Rifle that does not shake the view at all.
const PACKAGES = [
  ["Botpack", "BotPack.u"],
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
const pkg = pkgs[0].pkg; // Botpack: meshes and textures

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
 * UE1 only serializes the properties a class actually overrides, so `ShockRifle` has no
 * shakemag of its own and reading it alone reports undefined rather than 300. The chain
 * crosses packages (Botpack.TournamentWeapon extends Engine.Weapon), which is why every
 * package is loaded above rather than just Botpack.
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

/** A UE1 rotator component (65536 to the turn) as degrees. */
const rotDeg = (units) => (units * 360) / 65536;
const r4 = (n) => Math.round(n * 10000) / 10000;
const r6 = (n) => Math.round(n * 1e6) / 1e6;

/** An FVector property, which readProperties hands back as raw struct bytes. */
function vec(v) {
  if (!v || !v.bytes) return null;
  const b = Buffer.from(v.bytes.data || v.bytes);
  return b.length >= 12 ? [b.readFloatLE(0), b.readFloatLE(4), b.readFloatLE(8)] : null;
}

// ---------------------------------------------------------------------------
// THE MESH -> VIEW FRAME TRANSFORM
// ---------------------------------------------------------------------------

/**
 * UE1's FRotationMatrix for a rotator, in degrees. Rows are the rotated frame's axes.
 *
 * Kept in this shape rather than as three composed Euler rotations because the row form
 * is the one that makes the transpose below obviously the right thing: row i dotted with
 * a mesh-frame vector gives its component along parent axis i, so M^T takes mesh
 * components to parent components.
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

// UT axes (x forward, y right, z up) -> the view frame the client draws in (x right,
// y up, z BACK, so forward is -z). UT is left-handed and glTF is right-handed, so this
// matrix has determinant -1 — see the winding note where the indices are built.
const UT_TO_VIEW = [
  [0, 1, 0],
  [0, 0, 1],
  [-1, 0, 0],
];

/**
 * The full mesh-local -> view-frame matrix for one mesh.
 *
 * Mesh.Origin is deliberately NOT applied. It places a mesh relative to the ACTOR
 * carrying it, which is not the question a first-person view mesh answers, and five of
 * these six have an Origin of exactly zero — so it is inert for everything except
 * WarHead, whose (0, -210, -50) throws the Redeemer about 5 metres from the camera.
 */
function viewMatrix(mesh, viewScale) {
  const k = UU_TO_M * viewScale;
  const scale = [
    [mesh.scale[0] * k, 0, 0],
    [0, mesh.scale[1] * k, 0],
    [0, 0, mesh.scale[2] * k],
  ];
  const [pitch, yaw, roll] = mesh.rotOrigin.map(rotDeg);
  return matMul(UT_TO_VIEW, matMul(transpose(rotationMatrix(pitch, yaw, roll)), scale));
}

/**
 * The barrel tip, in view-frame metres.
 *
 * Derived, not measured by hand: take the vertices at the FRONT of the weapon (view
 * forward is -Z) and average them. The frontmost geometry of a held weapon is its muzzle
 * — the arm is always behind the gun — so this needs no per-weapon knowledge and cannot
 * drift when a mesh changes. It is computed on the REST pose, because on a fire frame
 * the whole gun has recoiled.
 */
function barrelTip(pos) {
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pos) {
    if (p[2] < minZ) minZ = p[2];
    if (p[2] > maxZ) maxZ = p[2];
  }
  // The frontmost 6% of the weapon's length. Wide enough to average a ring of muzzle
  // vertices rather than latch onto one stray point, narrow enough not to creep back
  // down the barrel.
  const cutoff = minZ + (maxZ - minZ) * 0.06;
  let n = 0;
  const sum = [0, 0, 0];
  for (const p of pos) {
    if (p[2] > cutoff) continue;
    sum[0] += p[0];
    sum[1] += p[1];
    sum[2] += p[2];
    n++;
  }
  if (!n) throw new Error("no vertices at the front of the mesh");
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}

/**
 * The signed volume the emitted triangles enclose, as glTF reads them.
 *
 * glTF front faces are counter-clockwise seen from outside, so a closed mesh wound that
 * way has POSITIVE signed volume about any interior point. These meshes are not quite
 * closed — the arm is cut off at the wrist — but the open end is a small flat disc
 * against a whole gun, so the sign is not in doubt: measured, the Enforcer's raw wedge
 * order gives -5.16e-5 m^3 and the reversed order +5.16e-5, and every one of the seven
 * meshes lands the same way round. This is CHECKED rather than reasoned about because a
 * coordinate swap with determinant -1 reverses winding, and "the old code already flipped
 * once" is not evidence about a different swap — the check and the determinant have to
 * agree or the build stops.
 */
function signedVolume(positions, indices) {
  const centre = [0, 0, 0];
  for (let i = 0; i < positions.length; i += 3) {
    centre[0] += positions[i] / (positions.length / 3);
    centre[1] += positions[i + 1] / (positions.length / 3);
    centre[2] += positions[i + 2] / (positions.length / 3);
  }
  let v = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const p = [0, 1, 2].map((j) => {
      const o = indices[i + j] * 3;
      return [positions[o] - centre[0], positions[o + 1] - centre[1], positions[o + 2] - centre[2]];
    });
    const [a, b, c] = p;
    v +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return v;
}

// ---------------------------------------------------------------------------
// WHICH ANIMATIONS EACH WEAPON PLAYS
// ---------------------------------------------------------------------------
// Read out of the UnrealScript each package ships (scripts/lib/upkg.mjs scriptText), not
// invented. The second argument to PlayAnim/LoopAnim is a RATE MULTIPLIER on the
// sequence's own authored fps; a bare number below is one of those multipliers.
//
//   enforcer        PlayFiring        PlayAnim('Shoot', 0.5 + 0.31 * FireAdjust)
//                   PlayRepeatFiring  PlayAnim('Shot2', 0.7 + 0.3 * FireAdjust)
//                   PlayIdleAnim      FRand() > 0.96 ? PlayAnim('Twiddle', 0.6)
//                                                    : LoopAnim('Sway', 0.2)
//   SniperRifle     PlayFiring        PlayAnim(FireAnims[Rand(5)], 0.5 + 0.5 * FireAdjust)
//                   PlayIdleAnim      PlayAnim('Still', 1.0)
//   ShockRifle      PlayFiring        LoopAnim('Fire1', 0.30 + 0.30 * FireAdjust)
//                   PlayIdleAnim      LoopAnim('Still', 0.04)
//   UT_Eightball    PlayRFiring       PlayAnim(FireAnim[num], 0.6)   num = rockets - 1
//                   PlayIdleAnim      PlayAnim('Idle', 0.1) / TweenAnim('Idle', 0.5)
//   ripper          PlayFiring        LoopAnim('Fire', 0.7 + 0.6 * FireAdjust)
//                   PlayIdleAnim      LoopAnim('Idle', 0.3)
//   WarheadLauncher PlayFiring        PlayAnim('Fire', 0.3)
//                   (no PlayIdleAnim — TournamentWeapon's is an empty function)
//
// and for all six, from TournamentWeapon:
//   PlaySelect   PlayAnim('Select', 1.0) + Owner.PlaySound(SelectSound)
//   TweenDown    PlayAnim('Down', 1.0)
//
// FireAdjust is a TournamentWeapon default and is 1.0; bots lower it, a human player
// never does. It is read rather than folded in so the arithmetic above stays checkable.
//
// `tween` is PlayAnim/LoopAnim's third argument: seconds spent blending from the pose the
// mesh is in to the new sequence's first frame. Fire clips get 0.02-0.05 (a couple of
// frames — enough to take the edge off the jump into the recoil pose, which on the Shock
// Rifle is 95 px of barrel), idles 0.1-0.5, Select 0 (it starts off-screen anyway). The
// Redeemer's PlayAnim('Fire', 0.3) passes none, so it cuts straight into the kicked-up
// tube: that buck is the weapon, not a bug. Every value is copied from the call site.
const SELECT_RATE = 1.0;
const DOWN_RATE = 1.0;

/** Per-weapon clip plan, given that weapon's merged defaults and FireAdjust. */
function clipPlan(id, d, fireAdjust) {
  switch (id) {
    case "enforcer":
      return {
        fire: [{ clip: "Shoot", rate: 0.5 + 0.31 * fireAdjust, tween: 0.02 }],
        // PlayRepeatFiring's animation, for every shot AFTER the first while the trigger
        // stays down (state NormalFire re-fires through it once 'Shoot' has finished).
        // It is not a random alternative to 'Shoot': the two start from different poses,
        // and picking between them per shot made the gun snap 70 px between shots.
        // UnrealScript spells it 'Shot2'; the sequence in the package is 'shot2', and UE1
        // names are case-insensitive where glTF's are not, so the PACKAGE spelling is
        // what gets written.
        fireRepeat: { clip: "shot2", rate: 0.7 + 0.3 * fireAdjust, tween: 0.05 },
        fireLoops: false,
        idle: { clip: "Sway", rate: 0.2, loop: true, tween: 0.1 },
        idleFidget: { clip: "Twiddle", rate: 0.6, chance: 0.04, tween: 0.3 },
      };
    case "sniper":
      return {
        // FireAnims is a five-name array in the class defaults, picked from at random per
        // shot. Read, not typed: Fire, Fire2, Fire3, Fire4, Fire5.
        fire: names(d.FireAnims).map((clip) => ({ clip, rate: 0.5 + 0.5 * fireAdjust, tween: 0.05 })),
        fireLoops: false,
        idle: { clip: "Still", rate: 1.0, loop: true, tween: 0.05 },
      };
    case "shock":
      return {
        fire: [{ clip: "Fire1", rate: 0.3 + 0.3 * fireAdjust, tween: 0.05 }],
        fireLoops: true,
        idle: { clip: "Still", rate: 0.04, loop: true, tween: 0.3 },
      };
    case "rocket":
      // FireAnim[0] — one rocket loaded. The array's later entries are the 2..6 rocket
      // volleys, which this game does not implement.
      return {
        fire: [{ clip: names(d.FireAnim)[0], rate: 0.6, tween: 0.05 }],
        fireLoops: false,
        idle: { clip: "Idle", rate: 0.1, loop: true, tween: 0.5 },
      };
    case "ripper":
      return {
        fire: [{ clip: "Fire", rate: 0.7 + 0.6 * fireAdjust, tween: 0.05 }],
        fireLoops: true,
        idle: { clip: "Idle", rate: 0.3, loop: true, tween: 0.4 },
      };
    case "redeemer":
      return {
        fire: [{ clip: "Fire", rate: 0.3, tween: 0 }],
        fireLoops: false,
        // No idle, and that is Epic's: TournamentWeapon.PlayIdleAnim is an empty function
        // and WarheadLauncher does not override it, so the Redeemer rests on its 'Still'
        // frame and the mesh's five-frame 'Idle' sequence is never played. A first pass
        // emitted it anyway at a guessed rate of 1.0 "so the weapon would not look dead",
        // which looped it six times a second and made the Redeemer twitch constantly —
        // measured at a 200 px jump every time the loop wrapped. Dead in the hand is what
        // UT99 looks like here.
      };
    default:
      throw new Error(`${id}: no clip plan`);
  }
}

/** A name-array default, as a plain array of strings. */
function names(v) {
  if (Array.isArray(v)) return v.filter((n) => typeof n === "string");
  return typeof v === "string" ? [v] : [];
}

// id -> the weapon CLASS in Botpack. Two of these are traps and both cost time once:
// the Enforcer's class is lowercase `enforcer`, and the Ripper's is `ripper` — `Razor2`
// is its PROJECTILE (it extends Engine.Projectile), and is also, separately, the name of
// the Ripper's view MESH. Looking up `Razor2` as the weapon returns a projectile whose
// defaults have no PlayerViewMesh at all.
//
// `hand` is which of the player's hands UT99 draws that weapon in. It is the Enforcer
// that is special: enforcer.SetHand picks between two MIRRORED meshes — AutoML for the
// left hand and AutoMR for the right — and its RenderOverlays forces
// PlayerOwner.Handedness = 1 for a single Enforcer, so a lone Enforcer is always the LEFT
// one. A dual pair is AutoMR (right) plus AutoML (left), which is why both meshes are
// extracted. The other five have one mesh each; every weapon's PlayerViewOffset.Y is
// negative, i.e. authored left of centre, and Engine.Weapon.SetHand multiplies that Y by
// Hand to put it on the other side — so they are LEFT-HAND-AUTHORED guns that UE1
// mirrors for a right-handed player. Nothing is mirrored here: the client owns that
// decision and `hand` is what it decides with.
const WEAPONS = [
  { id: "enforcer", cls: "enforcer", hand: "left", dualMesh: "AutoMR" },
  { id: "sniper", cls: "SniperRifle", hand: "right" },
  { id: "shock", cls: "ShockRifle", hand: "right" },
  { id: "rocket", cls: "UT_Eightball", hand: "right" },
  { id: "ripper", cls: "ripper", hand: "right" },
  { id: "redeemer", cls: "WarheadLauncher", hand: "right" },
];

// ---------------------------------------------------------------------------
// MUZZLE FLASH
// ---------------------------------------------------------------------------
// Engine.Weapon.RenderOverlays draws it as a 2D canvas icon, not as geometry: if
// bDrawMuzzleFlash and MFTexture != None, an icon FlashS * MuzzleScale * ClipX/640 pixels
// across, for FlashLength seconds, at Canvas.Style 3 (STY_Translucent — brightness IS
// opacity, so the black background is invisible and the client should blend it
// additively). FlashY/FlashO/FlashC place it on screen.
//
// Only two of the six have an MFTexture at all. The Enforcer's is picked at random from
// MuzzleFlashVariations on each render (`MFTexture = MuzzleFlashVariations[Rand(5)]`), so
// all five variations are extracted; its own MFTexture default of Muz1 is just the first
// of them. The Sniper Rifle has one fixed MuzzleFlash2. The other four draw no flash.
const FLASH_KEYS = ["FlashS", "MuzzleScale", "FlashLength", "FlashY", "FlashO", "FlashC"];

/** Extract a Botpack texture to assets/ut99/ under that directory's Package.Group.Name convention. */
function extractUt99Texture(name) {
  const exp = pkg.exports.find((e) => e.name === name && /Texture/.test(pkg.classOf(e) || ""));
  if (!exp) throw new Error(`${name}: no Texture export in BotPack.u`);
  const group = pkg.resolve(exp.package);
  const file = `BotPack.${group ? `${group}.` : ""}${name}.png`;
  const img = readTexture(pkg, name);
  const rgba = Buffer.from(img.rgba.buffer, img.rgba.byteOffset, img.rgba.length);
  fs.mkdirSync(UT99_DIR, { recursive: true });
  fs.writeFileSync(path.join(UT99_DIR, file), writePng(img.width, img.height, rgba));
  return { path: `assets/ut99/${file}`, size: [img.width, img.height] };
}

// ---------------------------------------------------------------------------
// BUILD
// ---------------------------------------------------------------------------

const manifest = {};
const flashTextures = new Map(); // texture name -> manifest path, extracted once
fs.mkdirSync(OUT_DIR, { recursive: true });

for (const spec of WEAPONS) {
  const cls = findClass(spec.cls);
  const d = inheritedDefaults(spec.cls);
  const meshName = d.PlayerViewMesh;
  if (!meshName) throw new Error(`${spec.id}: ${spec.cls} has no PlayerViewMesh`);
  // PlayerViewScale is inherited by the Enforcer and the Redeemer rather than set, and
  // Engine.Inventory's default is 1. Reading it as 0 would collapse the mesh to a point.
  const viewScale = d.PlayerViewScale ?? 1;
  if (!(viewScale > 0)) throw new Error(`${spec.id}: PlayerViewScale is ${viewScale}`);
  const fireAdjust = d.FireAdjust ?? 1;

  const dir = path.join(OUT_DIR, spec.id);
  fs.mkdirSync(dir, { recursive: true });
  const pngFor = new Map(); // texture name -> image index, shared by the Enforcer's two meshes

  const plan = clipPlan(spec.id, d, fireAdjust);
  const clips = [
    ...plan.fire.map((f) => ({ ...f, loop: plan.fireLoops })),
    ...(plan.fireRepeat ? [{ ...plan.fireRepeat, loop: false }] : []),
    ...(plan.idle ? [plan.idle] : []),
    ...(plan.idleFidget ? [plan.idleFidget] : []),
    { clip: "Select", rate: SELECT_RATE },
    { clip: "Down", rate: DOWN_RATE },
  ];

  const primary = buildModel(spec, meshName, viewScale, dir, spec.id, clips, pngFor);
  const dual = spec.dualMesh
    ? buildModel(spec, spec.dualMesh, viewScale, dir, `${spec.id}-right`, clips, pngFor)
    : null;

  // --- firing feel -------------------------------------------------------
  // ShakeView(ShakeTime, ShakeMag, ShakeVert) fires on every shot from
  // TournamentWeapon.ClientFire. The names are lowercase in the package.
  const shake = {
    time: r6(d.shaketime),
    mag: r6(d.shakemag),
    vert: r6(d.shakevert),
  };
  for (const [k, v] of Object.entries(shake)) {
    if (!Number.isFinite(v) || !(v > 0)) throw new Error(`${spec.id}: shake.${k} is ${v}`);
  }

  // ClientInstantFlash(InstFlash, InstFog) — a full-screen tint, only when InstFlash != 0.
  // PlayerPawn stores InstantFog = 0.001 * fog, so the scaling is done here once.
  //
  // The Rocket Launcher has no InstFlash DEFAULT: its flash is written into PlayRFiring
  // as `ClientInstantFlash(-0.4, vect(650, 450, 190))`. Rather than type those four
  // numbers, they are read out of the class's own source, the same way the projectile
  // blast radii are — see docs/ut99-character-extraction.md.
  let instFlash = null;
  const fog = vec(d.InstFog);
  if (d.InstFlash && fog) {
    instFlash = { scale: r6(d.InstFlash), fog: fog.map((c) => r6(c * 0.001)) };
  } else {
    const src = scriptText(cls.pkg, cls.exp) || "";
    const m = src.match(
      /ClientInstantFlash\s*\(\s*(-?[\d.]+)\s*,\s*vect\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/i,
    );
    if (m) {
      instFlash = {
        scale: r6(Number(m[1])),
        fog: [r6(Number(m[2]) * 0.001), r6(Number(m[3]) * 0.001), r6(Number(m[4]) * 0.001)],
        from: "class source (no InstFlash default)",
      };
    }
  }

  let muzzleFlash = null;
  if (d.bDrawMuzzleFlash && d.MFTexture) {
    const variations = names(d.MuzzleFlashVariations);
    const list = variations.length ? variations : [d.MFTexture];
    muzzleFlash = { textures: [] };
    for (const t of list) {
      if (!flashTextures.has(t)) flashTextures.set(t, extractUt99Texture(t).path);
      muzzleFlash.textures.push(flashTextures.get(t));
    }
    for (const k of FLASH_KEYS) {
      const v = d[k];
      if (!Number.isFinite(v)) throw new Error(`${spec.id}: ${k} is ${v}`);
      muzzleFlash[k[0].toLowerCase() + k.slice(1)] = r6(v);
    }
  }

  const [pitch, yaw, roll] = readMesh(pkg, meshName).rotOrigin.map(rotDeg);
  manifest[spec.id] = {
    model: `assets/3d/viewmodels/${spec.id}/${spec.id}.gltf`,
    ...(dual ? { dualModel: `assets/3d/viewmodels/${spec.id}/${spec.id}-right.gltf` } : {}),
    mesh: meshName,
    ...(dual ? { dualMesh: spec.dualMesh } : {}),
    hand: spec.hand,
    viewScale,
    // Kept for compatibility and always zero: the orientation is baked into the geometry
    // now, so there is nothing left for the client to rotate.
    rotationDeg: [0, 0, 0],
    orientation: {
      // What was applied, which IS Epic's RotOrigin — the three are equal by construction
      // and are emitted separately so that a future change to one is visible against the
      // other rather than silent.
      pitchDegUT: r4(pitch),
      yawDegUT: r4(yaw),
      rollDegUT: r4(roll),
      epicRotOriginDeg: [r4(pitch), r4(yaw), r4(roll)],
      note:
        "Baked into the geometry. Vertices are mesh-frame, so they reach the actor frame " +
        "through the TRANSPOSE of UE1's FRotationMatrix(RotOrigin) — verified on all six " +
        "meshes by recoil direction, holster direction and long-axis; see the script header. " +
        "Then UT (x fwd, y right, z up) -> view (x right, y up, z back).",
    },
    muzzleLocal: primary.muzzle.map(r4),
    // The dual pair's right-hand gun is AutoMR, the MIRROR of AutoML across mesh X, so
    // its barrel tip is not the same point — it is the same point with x negated. Emitted
    // rather than left for the client to derive, because "just negate x" is exactly the
    // kind of thing that is true until someone changes the view frame.
    ...(dual ? { dualMuzzleLocal: dual.muzzle.map(r4) } : {}),
    playerViewOffsetUU: (vec(d.PlayerViewOffset) || [0, 0, 0]).map(r4),
    fireOffsetUU: (vec(d.FireOffset) || [0, 0, 0]).map(r4),
    sizeM: primary.size.map(r4),
    // The mesh's actual box, not just its extents. server/test/viewmodels.test.mjs uses
    // it to assert the muzzle lies INSIDE the weapon — the check that catches a mesh
    // being displaced wholesale, which is exactly what applying WarHead's Origin did
    // (it put the Redeemer's barrel tip about 5 m from a mesh 5 cm deep).
    bboxM: { min: primary.min.map(r4), max: primary.max.map(r4) },
    baseFrame: primary.baseFrame,
    baseSequence: primary.baseSequence,
    anims: {
      fire: plan.fire.map((f) => ({ clip: f.clip, rate: r6(f.rate), tween: f.tween ?? 0 })),
      ...(plan.fireRepeat
        ? { fireRepeat: { clip: plan.fireRepeat.clip, rate: r6(plan.fireRepeat.rate), tween: plan.fireRepeat.tween ?? 0 } }
        : {}),
      fireLoops: plan.fireLoops,
      ...(plan.idle ? { idle: { ...plan.idle, rate: r6(plan.idle.rate) } } : {}),
      ...(plan.idleFidget
        ? { idleFidget: { ...plan.idleFidget, rate: r6(plan.idleFidget.rate) } }
        : {}),
      select: { clip: "Select", rate: SELECT_RATE, tween: 0 },
      down: { clip: "Down", rate: DOWN_RATE, tween: 0.05 },
    },
    ...(spec.id === "redeemer"
      ? {
          animNotes:
            "No idle, and that is Epic's: TournamentWeapon.PlayIdleAnim is empty and " +
            "WarheadLauncher does not override it. The Redeemer rests on its Still frame.",
        }
      : {}),
    shake,
    instFlash,
    muzzleFlash,
    selectSoundName: d.SelectSound ?? null,
    clipsInGltf: primary.clips,
  };

  console.log(
    `${spec.id.padEnd(9)} ${meshName.padEnd(9)}${dual ? ` + ${spec.dualMesh}` : "".padEnd(9)}` +
      `  ${String(primary.wedges).padStart(4)} wedges, ${primary.materials} mat, ` +
      `${primary.targets} morph targets, ${primary.clips.length} clips` +
      `   ${primary.size.map((n) => n.toFixed(3)).join(" x ")} m   ` +
      `bin ${(primary.binBytes / 1024).toFixed(0)}K${dual ? ` + ${(dual.binBytes / 1024).toFixed(0)}K` : ""}`,
  );
}

/**
 * One mesh -> one glTF + .bin + its skin PNGs, in the view frame, with morph clips.
 *
 * `pngFor` is shared across the calls that write into the same directory so that the
 * Enforcer's mirrored pair does not write two copies of the same four skins.
 */
function buildModel(spec, meshName, viewScale, dir, baseName, clips, pngFor) {
  const mesh = readMesh(pkg, meshName);
  const M = viewMatrix(mesh, viewScale);

  // The rest pose. NOT frame 0 — see the header: frame 0 is mid-Select on every one of
  // these meshes. 'Still' where there is one, 'Idle' otherwise.
  const stillSeq =
    mesh.anims.find((a) => a.name === "Still") || mesh.anims.find((a) => a.name === "Idle");
  if (!stillSeq) throw new Error(`${meshName}: no Still or Idle sequence to rest on`);
  const baseFrame = stillSeq.startFrame;

  const seqFor = (name) => {
    const s = mesh.anims.find((a) => a.name === name);
    if (!s) {
      throw new Error(
        `${meshName}: no sequence "${name}" — has ${mesh.anims.map((a) => a.name).join(", ")}`,
      );
    }
    if (!(s.rate > 0)) throw new Error(`${meshName}.${name}: rate is ${s.rate}`);
    return s;
  };

  // Every frame any clip touches, in ascending order, minus the base frame — its delta
  // is zero and an all-zero weight vector already means "the base pose".
  const wanted = new Set();
  for (const c of clips) {
    const s = seqFor(c.clip);
    for (let i = 0; i < s.numFrames; i++) wanted.add(s.startFrame + i);
  }
  wanted.delete(baseFrame);
  const frames = [...wanted].sort((a, b) => a - b);
  const targetOf = new Map(frames.map((f, i) => [f, i]));

  const framePos = (f) => mesh.frame(f).map((v) => apply(M, v));
  const basePos = framePos(baseFrame);

  // Wedges are per-corner already (a vertex index plus a UV), so they map one to one
  // onto glTF vertices and nothing needs splitting.
  const positions = [];
  const uvs = [];
  for (const w of mesh.wedges) {
    const p = basePos[w.v + mesh.specialVerts];
    if (!p) throw new Error(`${baseName}: wedge points at vertex ${w.v} of ${basePos.length}`);
    positions.push(...p);
    uvs.push(w.u / 256, w.vv / 256);
  }

  // --- winding -----------------------------------------------------------
  // The mesh -> view matrix has a negative determinant (UE1 is left-handed, glTF is
  // right-handed), which reverses triangle winding. Rather than trust that, derive it:
  // build both orders, keep the one whose signed volume is positive, and refuse to write
  // a mesh where the two do not disagree.
  const groups = new Map();
  for (const f of mesh.faces) {
    if (!groups.has(f.material)) groups.set(f.material, []);
    groups.get(f.material).push(...f.w);
  }
  const flat = [...groups.values()].flat();
  const asIs = signedVolume(positions, flat);
  const reversed = signedVolume(
    positions,
    flat.map((_, i, a) => a[i - (i % 3) + [0, 2, 1][i % 3]]),
  );
  if (!(asIs * reversed < 0)) {
    throw new Error(`${baseName}: winding test is not decisive (${asIs} vs ${reversed})`);
  }
  const flip = reversed > asIs;
  if (flip !== det3(M) < 0) {
    throw new Error(
      `${baseName}: winding disagrees with the transform's determinant ` +
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

  // --- morph targets: one per referenced frame, as POSITION deltas -------
  const targets = [];
  for (const f of frames) {
    const fp = framePos(f);
    const delta = new Float32Array(mesh.wedges.length * 3);
    mesh.wedges.forEach((w, i) => {
      const a = fp[w.v + mesh.specialVerts];
      const b = basePos[w.v + mesh.specialVerts];
      delta[i * 3] = a[0] - b[0];
      delta[i * 3 + 1] = a[1] - b[1];
      delta[i * 3 + 2] = a[2] - b[2];
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
  const texIndex = new Map(); // texture name -> this glTF's texture index
  for (const [matIndex, wedgeIdx] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const mat = mesh.materials[matIndex];
    const texName = mesh.textures[mat.textureIndex];
    if (!texName) throw new Error(`${baseName}: material ${matIndex} has no texture`);
    const flags = mat.polyFlags;
    // pngFor spans the whole directory so the Enforcer's mirrored pair, which uses the
    // same four skins, writes each PNG once and both glTFs point at the same files.
    if (!pngFor.has(texName)) {
      const file = `s${pngFor.size}.png`;
      // PF_Masked means palette index 0 is a hole, which is the only alpha UE1 has.
      const img = readTexture(pkg, texName, { masked: (flags & PF_MASKED) !== 0 });
      // writePng wants a Buffer (it uses .copy); utex hands back a Uint8Array.
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
    if (flags & PF_TRANSLUCENT) material.alphaMode = "BLEND";
    else if (flags & PF_MASKED) material.alphaMode = "MASK";
    // A first-person weapon is drawn in its own pass in UT99 and is not shaded by the
    // level around it. Honouring only PF_Unlit here would leave the gun lit by a night
    // sky, which is the bug that once rendered the ripper blade as a black disc.
    if (flags & PF_UNLIT) material.extensions = { KHR_materials_unlit: {} };

    const indices = [];
    for (let i = 0; i < wedgeIdx.length; i += 3) {
      for (const o of order) indices.push(wedgeIdx[i + o]);
    }
    const idxAccessor = accessors.length;
    accessors.push({
      bufferView: push(Buffer.from(new Uint16Array(indices).buffer), 34963),
      componentType: 5123,
      count: indices.length,
      type: "SCALAR",
    });
    primitives.push({
      attributes: { POSITION, TEXCOORD_0: TEXCOORD },
      indices: idxAccessor,
      material: materials.length,
      // Every primitive carries the same targets; three.js and the glTF spec both require
      // the count to match across a mesh's primitives, and a missing set on one primitive
      // leaves the arm frozen while the gun recoils.
      ...(targets.length ? { targets } : {}),
    });
    materials.push(material);
  }

  // --- animations --------------------------------------------------------
  // One glTF animation per clip, named EXACTLY as the sequence is named in the package
  // (case included — the client looks clips up by name and glTF names are case-sensitive
  // where UnrealScript's are not). Keyframe i sits at i/rate seconds, where rate is the
  // SEQUENCE's own authored fps; the multiplier UnrealScript passes to PlayAnim rides in
  // the manifest instead so one clip can serve two rates.
  const animations = [];
  const clipInfo = [];
  for (const c of clips) {
    const s = seqFor(c.clip);
    const n = s.numFrames;
    const keys = [];
    const weights = [];
    const one = (frame) => {
      const row = new Array(targets.length).fill(0);
      const t = targetOf.get(frame);
      if (t !== undefined) row[t] = 1;
      return row;
    };
    for (let i = 0; i < n; i++) {
      keys.push(i / s.rate);
      weights.push(...one(s.startFrame + i));
    }
    if (n === 1) {
      // A one-frame sequence ('Still' on four of the six, the Rocket Launcher's 'Idle').
      // A sampler with a single key has zero duration and some importers reject it, so it
      // gets a second identical key one frame later: a held pose, which is what it is.
      keys.push(1 / s.rate);
      weights.push(...one(s.startFrame));
    } else if (c.loop) {
      // A looping clip needs to arrive back where it started, or the wrap is a jump.
      keys.push(n / s.rate);
      weights.push(...one(s.startFrame));
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
      name: c.clip,
      samplers: [{ input, output, interpolation: "LINEAR" }],
      channels: [{ sampler: 0, target: { node: 0, path: "weights" } }],
    });
    clipInfo.push({
      clip: c.clip,
      startFrame: s.startFrame,
      numFrames: n,
      fps: r4(s.rate),
      seconds: r4(n / s.rate),
      loop: !!c.loop,
    });
  }

  const bin = Buffer.concat(parts);
  fs.writeFileSync(path.join(dir, `${baseName}.bin`), bin);

  const usedUnlit = materials.some((m) => m.extensions?.KHR_materials_unlit);
  const gltf = {
    asset: { version: "2.0", generator: "build-ut-viewmodels.mjs" },
    ...(usedUnlit ? { extensionsUsed: ["KHR_materials_unlit"] } : {}),
    extras: {
      // What the all-zero pose IS. The test asserts against this rather than trusting the
      // manifest, because the two are written from different places and a disagreement is
      // exactly the bug worth catching.
      utMesh: meshName,
      baseSequence: stillSeq.name,
      baseFrame,
      viewFrame: "barrel -Z, up +Y, screen right +X; RotOrigin baked in",
      clips: clipInfo,
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: baseName }],
    meshes: [
      {
        name: baseName,
        primitives,
        ...(targets.length ? { weights: new Array(targets.length).fill(0) } : {}),
      },
    ],
    materials,
    textures,
    images,
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    accessors,
    bufferViews,
    buffers: [{ uri: `${baseName}.bin`, byteLength: bin.length }],
    ...(animations.length ? { animations } : {}),
  };
  fs.writeFileSync(path.join(dir, `${baseName}.gltf`), JSON.stringify(gltf, null, 1) + "\n");

  const min = [0, 1, 2].map((a) => Math.min(...basePos.map((p) => p[a])));
  const max = [0, 1, 2].map((a) => Math.max(...basePos.map((p) => p[a])));
  const size = [0, 1, 2].map((a) => max[a] - min[a]);
  // A held weapon in the view frame is longest along Z, because view forward is -Z and a
  // gun points away from the eye. This is now ENFORCED rather than reported: with the
  // rest pose and Epic's RotOrigin all six pass, and the two that used to fail did so
  // because they were measured mid-Select.
  if (size.indexOf(Math.max(...size)) !== 2) {
    throw new Error(
      `${baseName}: longest along ${"XYZ"[size.indexOf(Math.max(...size))]}, not Z — ` +
        `the barrel is not pointing forward (size ${size.map((v) => v.toFixed(3)).join(" x ")})`,
    );
  }

  return {
    muzzle: barrelTip(basePos),
    min,
    max,
    size,
    baseFrame,
    baseSequence: stillSeq.name,
    wedges: mesh.wedges.length,
    materials: materials.length,
    targets: targets.length,
    clips: clipInfo,
    binBytes: bin.length,
  };
}

const manifestPath = path.join(ROOT, "scripts", "data", "ut-viewmodels.json");
fs.writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      $comment: [
        "UT99 first-person weapons: placement, orientation, animation and firing feel.",
        "GENERATED by scripts/build-ut-viewmodels.mjs from a retail install — do not hand-edit.",
        "",
        "Geometry is emitted in the VIEW FRAME (barrel -Z, up +Y, right +X), so rotationDeg",
        "is [0,0,0] and orientation.* only records what was baked in. The rest pose is the",
        "first frame of each mesh's own Still sequence, NOT frame 0 — frame 0 is mid-Select",
        "on all six and every measurement taken off it is a measurement of a gun mid-swing.",
        "",
        "anims.*.rate is UnrealScript's RATE MULTIPLIER on the clip's own authored fps, which",
        "is baked into the glTF keyframe times. Duration = numFrames / (fps * rate).",
        "",
        "shake is ShakeView(time, mag, vert); instFlash is ClientInstantFlash with the fog",
        "already multiplied by PlayerPawn's 0.001. muzzleFlash is a 2D canvas icon, drawn",
        "translucent (black is transparent — blend it additively), flashS * muzzleScale *",
        "ClipX/640 pixels across for flashLength seconds.",
        "",
        "playerViewOffsetUU and fireOffsetUU are RAW Unreal Units and are NOT directly",
        "convertible to metres: UE1 draws the view weapon through its own projection. Their",
        "value is that they are consistent with each other. See the script header.",
      ],
      weapons: manifest,
    },
    null,
    1,
  ) + "\n",
);
console.log(`\nwrote ${path.relative(ROOT, manifestPath)}`);
if (flashTextures.size) {
  console.log(
    `wrote ${flashTextures.size} muzzle-flash textures to assets/ut99/ — ` +
      `remember they are Epic's; assets/ut99/NOTICE.md lists them.`,
  );
}
