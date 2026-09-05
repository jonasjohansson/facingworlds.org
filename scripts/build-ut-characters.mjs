#!/usr/bin/env node
// build-ut-characters.mjs — the eight playable UT99 bodies, out of the retail packages
// and into glTF, facing the way the rest of the game thinks they face.
//
//   node scripts/build-ut-characters.mjs [path-to-UT-System]
//
// DEV TOOLING, like build-ut-viewmodels.mjs: it needs a retail install, so it is not part
// of any build. It rewrites assets/3d/characters/<id>/<id>.gltf and <id>.bin, and those
// are committed. It does NOT write the skin PNGs — see SKINS ARE NOT RE-EXTRACTED below.
//
// ---------------------------------------------------------------------------
// WHAT THIS FIXES: SIX OF THE EIGHT BODIES RAN BACKWARDS
// ---------------------------------------------------------------------------
// The committed character glTFs came out of a throwaway extractor that never applied
// RotOrigin. docs/ut99-character-extraction.md wrote the mistake down as a rule —
// "modelling the rotator is a trap ... so read the axis off RotOrigin and assert it
// matches the tallest axis of the idle pose" — which fixes UP and nothing else. Every
// body stood at the right height, so nothing looked broken, and every body was free to be
// turned any way at all about that axis.
//
// Measured off the committed geometry's OWN Run clips, by the planted-foot method used
// below, as degrees off -Z — which is the rig's forward (A-Frame's camera convention; the
// server's bots set rig ry = atan2(-dx, -dz), so the rig faces its own motion):
//
//     in the file, before   soldier -179.6  commando -179.8  fcommando +179.6
//                           sgirl   +179.6  boss     -179.6  nali      +178.4
//                           skaarj   +90.0  warcow    +92.0
//     after                 all eight within 2 degrees of 0
//
// Six bodies faced exactly +Z: backwards, at every moment, in the game. It was found by
// photographing a commando bot head-on and seeing the back of his head, because a
// backwards body is a valid glTF of the right height playing the right clips.
//
// The earlier patch in gen-characters.mjs, `YAW_FIX = { skaarj: 90, warcow: 90 }`, took
// the last two of those rows to 0.0 and +2.0 and did nothing for the six — it rescued the
// only two models that were NOT running backwards. It had been fitted to a different
// measurement, the direction the feet sit forward of the body, which reads the STANCE
// rather than the body: which boot is in front depends on where in the stride the sampled
// frame sits.
//
// ---------------------------------------------------------------------------
// THE RULE, WHICH IS THE WEAPONS' RULE UNCHANGED
// ---------------------------------------------------------------------------
// Exactly what scripts/build-ut-viewmodels.mjs derived and verified three ways on the six
// view meshes, applied here with no per-model exception:
//
//   1. mesh vertex x Mesh.Scale
//   2. x the TRANSPOSE of UE1's FRotationMatrix(RotOrigin). That matrix's ROWS are the
//      rotated frame's axes expressed in the parent frame, so row i dotted with a
//      mesh-frame vector gives its component along parent axis i — M^T is what takes mesh
//      components to ACTOR components. This is the whole trick, and it is the difference
//      between "Epic's numbers cannot be applied uniformly" and "they can".
//   3. x UT_TO_WORLD (x_world = UT y, y_world = UT z, z_world = -UT x). UE1 is
//      left-handed and glTF is right-handed, so this has determinant -1 and face winding
//      has to be re-derived rather than assumed — see the winding block.
//
// Tested on all eight pawn meshes' RunSm cycles before this script existed: every one
// comes out Z-up in actor space with its run direction along +X to within 2 degrees,
// TSkM and TCowMesh included even though their RotOrigin is (0, 0, 0). UE1 pawns face +X.
// So through UT_TO_WORLD every character faces -Z and there is no per-model yaw at all.
// That measurement is not taken on trust: runHeading() below re-derives it from the
// emitted geometry and this script refuses to write a body that is more than 2 degrees
// off -Z.
//
// ---------------------------------------------------------------------------
// Mesh.Origin, AND WHERE THE BODY STANDS
// ---------------------------------------------------------------------------
// A pawn mesh carries a non-zero Mesh.Origin — Soldier (-150, 40, 0), TSkM (100, 0, -72)
// — which places the mesh on the ACTOR. UE1 transforms a vertex as (V - Origin) through a
// coordinate system that already carries Scale, i.e. Origin is subtracted in RAW packed
// vertex units, BEFORE Mesh.Scale. That is measured here, not assumed, and the measurement
// is unambiguous: a UT99 pawn's collision cylinder is 39 units half-height, so its feet
// should sit near actor z = -39.
//
//     feet z, idle pose        Origin ignored          (V - Origin) x Scale
//     Soldier                       -40.1                   -42.6
//     Commando                      -40.2                   -42.7
//     FCommando                     -50.3                   -43.1
//     SGirl                         -50.5                   -43.3
//     Boss                          -37.6                   -39.9
//     TSkM                          -51.5                   -43.1
//     tnalimesh                     -44.9                   -41.2
//     TCowMesh                      -43.2                   -43.2   (Origin is zero)
//
// Ignoring it scatters the feet over 14 units; applying it before the scale pulls all
// eight into a 3.4-unit band just under the cylinder, which is where a UT99 pawn's boots
// actually are. Applying it AFTER the scale (V x Scale - Origin) throws the Skaarj 100
// units off and is not a candidate. Horizontally it does the same job: it brings the three
// meshes authored at Origin (-150, 40, 0) from a feet centroid about 10 units off the
// cylinder axis to within 1.4 of it.
//
// The actor origin is the CENTRE of the collision cylinder; the game's rig is the FLOOR.
// So after the transform the whole body is translated up until the Idle clip's first frame
// touches y = 0, and left alone horizontally: where Epic put the body over its cylinder
// axis is information, and re-centring on the bounding box (which is what the old
// extractor did) throws it away.
//
// ---------------------------------------------------------------------------
// SCALE: WHY 1.830 m AND NOT JUST UU_TO_M
// ---------------------------------------------------------------------------
// UU_TO_M is 0.0235 m/UU, UT99 pawn scale. Run the meshes through it raw and they stand
// 1.80 m (Soldier) to 2.07 m (Skaarj) — Epic's own spread, and honest. But UT99 does not
// use it: every one of these pawns, cow included, walks around inside the SAME 39-unit
// collision cylinder, and it is the cylinder the game is built against, not the mesh.
// 2 x 39 x UU_TO_M = 1.833 m, and the committed models have always stood at 1.830 m — the
// nameplate heights, the AR figures and the hit feedback are all placed against that.
//
// So each body is scaled uniformly to STANDING_HEIGHT_M, and the factor it needed is
// reported and written into the glTF's extras. The factors are all within 8% of 1: this is
// a nudge onto the shared cylinder, not a reshaping. It is the one number here that is not
// Epic's, and it is called out rather than hidden.
//
// ---------------------------------------------------------------------------
// WHICH SIX SEQUENCES, AND WHY Idle IS ONE FRAME
// ---------------------------------------------------------------------------
// The client binds clips by name, so the glTF animation names are the contract. WHICH
// UT99 sequence goes in each is read out of Botpack.TournamentPlayer's own UnrealScript,
// which the package still ships:
//
//   PlayWalking()    LoopAnim(Weapon.Mass < 20 ? 'WalkSM' : 'WalkLG')
//   PlayRunning()    LoopAnim(Weapon.Mass < 20 ? 'RunSM'  : 'RunLG')
//   PlayWaiting()    ... Weapon.bPointing: TweenAnim('StillSMFR', 0.3)
//   PlayFiring()     RunSM -> RunSMFR, WalkSM -> WalkSMFR, otherwise TweenAnim('StillSMFR', 0.02)
//   PlayRecoil(Rate) AnimSequence == 'StillSmFr': PlayAnim('StillSmFr', Rate, 0.02)
//
// Everyone in this game spawns with the Enforcer and never puts it down, and the
// Enforcer's Mass is 15, so the SMALL-weapon variant is the right one everywhere and the
// LG/FrRp family (Mass >= 20 rifles) is not shipped at all. PlayWeaponSwitch confirms the
// pairing from the other side: it rewrites 'StillSMFR' to 'StillFRRP' and back as the
// carried weapon crosses Mass 20.
//
//     clip       UT99 sequence   played by
//     Idle       StillSmFr[0]    PlayWaiting / PlayFiring, HELD
//     Walk       WalkSm          PlayWalking
//     Run        RunSm           PlayRunning
//     Fire       StillSmFr       PlayRecoil, once per shot
//     WalkFire   WalkSmFr        PlayFiring while walking
//     RunFire    RunSmFr         PlayFiring while running
//
// THE Idle FIX. TweenAnim(name, time) does not play a sequence: it blends to that
// sequence's FIRST FRAME over `time` seconds and stops there, AnimRate 0. So a standing
// UT99 pawn holding a gun is frame 0 of StillSmFr, motionless. The eight frames after it
// are the RECOIL, and the only thing that ever plays them is PlayRecoil, once per shot.
//
// The previous build of this script emitted Idle as the whole StillSmFr sequence LOOPED,
// which is why every standing avatar twitched through a recoil forever — a shot animation
// running eight frames a second on a pawn that was not firing. Idle is therefore emitted
// as a ONE-KEYFRAME clip: the base pose, held. (It still gets a second identical key, the
// same as any one-frame sequence here — a sampler with a single key has zero duration and
// some importers reject it.) The recoil is not thrown away; it is the Fire clip, one-shot.
//
// Idle's frame IS the base frame, so all six clips share a base pose and blending between
// any two of them is blending between poses of the same body.
//
// EPIC'S OWN ODDITIES, passed through unchanged and worth knowing before they look like
// bugs here:
//
//   tnalimesh's StillSmFr is a SINGLE frame, so the Nali's Fire clip is one frame long
//   and a firing Nali does not recoil. That is what UT99 draws.
//
//   TCowMesh's WalkSmFr and RunSmFr are the SAME sixteen frames (250..265) as its WalkSm
//   and RunSm, at the same rates, so the cow's firing walk is its walk. Its WalkSm and
//   RunSm are also each other (15 and 27 fps of one cycle), so the cow runs by walking
//   faster. Four clips, one animation.
//
//   TSkM's WalkLg is its WalkSm, and its StillSmFr is 8 frames at 15 fps like everyone
//   else's, so the Skaarj needs no special case.
//
// All eight meshes carry all six names — checked, not assumed: seqFor() throws with the
// mesh's own sequence list if one is ever missing.
//
// ---------------------------------------------------------------------------
// ANIMATION: MORPH TARGETS, THE SAME WAY THE WEAPONS DO IT
// ---------------------------------------------------------------------------
// UT99 characters are vertex animated, not skinned: the mesh carries a full set of
// positions for every frame and AnimSeqs names spans of them. One glTF morph target per
// unique frame, one animation per clip stepping a one-hot weight vector, LINEAR — UE1
// interpolates linearly between frames, so a linear ramp between adjacent one-hot vectors
// reproduces it exactly. (The old files used STEP, which judders a 10-frame run cycle.)
//
// The base pose is the Idle clip's first frame, and no target is emitted for it: its delta
// is zero and an all-zero weight vector already means the base pose. A one-frame sequence
// — the Nali's StillSmFr is one frame — gets a second identical keyframe, because a
// sampler with a single key has zero duration and some importers reject it.
//
// ---------------------------------------------------------------------------
// SKINS ARE NOT RE-EXTRACTED
// ---------------------------------------------------------------------------
// The skin PNGs under assets/3d/characters/<id>/<skin>/s0..sN.png stay exactly as they
// are. A pawn mesh's own material textures are EMPTY names — UT99 assigns them at runtime
// through MultiSkins — so there is nothing to read out of the package anyway, and the
// slot mapping is positional: material slot i is skin file sN with N = i. The client
// depends on that (remote-avatar.js matches /slot(\d+)$/ on the material name and hangs
// urls[i] on it), so before overwriting anything this script re-reads the OLD glTF and
// refuses to write unless, for every slot, the triangle count and the number of distinct
// vertices that slot references are identical. A body that came out mis-skinned would look
// like a body.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadPackage } from "./lib/upkg.mjs";
import { readMesh } from "./lib/umesh.mjs";
import { UU_TO_M } from "../src/shared/map-transform.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT_DIR = path.join(ROOT, "assets", "3d", "characters");
const SYSTEM =
  process.argv[2] || path.join(os.homedir(), "Downloads", "Unreal Tournament", "System");

// UE1 PolyFlags. Only one of them means anything on a character: the Boss's visor, the
// Nali's eyes and one flap of the cow are authored two-sided. PF_MASKED is deliberately
// NOT turned into alphaMode here — the committed skins are palettized PNGs with no alpha
// channel and no tRNS, so a MASK material would have nothing to cut against. Re-extracting
// the skins masked is a separate job.
const PF_TWOSIDED = 0x00000100;

// Every UT99 pawn stands in a 39-unit half-height collision cylinder. Everything in the
// game — nameplates, the AR figures, the shot feedback — is placed against a body of this
// height, and 2 * 39 * UU_TO_M is 1.833 m, so 1.830 is the cylinder rounded, not a guess.
const STANDING_HEIGHT_M = 1.83;
// The pawn cylinder's half height, used only by the placement self-check below.
const COLLISION_HEIGHT_UU = 39;

// The empty node every character carries for its weapon, and its index. It is node 1,
// after the mesh node, on every model — but the NAME is the contract: a client looks the
// node up by name, because an index is the kind of thing that quietly becomes wrong.
const ANCHOR_NAME = "weaponAnchor";
const ANCHOR_NODE = 1;

const PACKAGES = {
  botpack: "BotPack.u",
  bonus: "epiccustommodels.u",
};

// The eight bodies. `skin` is the skin directory whose PNGs the glTF references by
// default; it is only a fallback, because network.js writes the server-chosen variant's
// texture list onto the rig as data-skin and remote-avatar.js replaces every slot before
// the first frame is drawn. These are the directories the committed files have always
// pointed at and they are kept so this rebuild changes orientation and nothing else.
const CHARACTERS = [
  { id: "soldier", mesh: "Soldier", pkg: "botpack", skin: "malcom" },
  { id: "commando", mesh: "Commando", pkg: "botpack", skin: "graves" },
  { id: "fcommando", mesh: "FCommando", pkg: "botpack", skin: "jayce" },
  { id: "sgirl", mesh: "SGirl", pkg: "botpack", skin: "aryss" },
  { id: "boss", mesh: "Boss", pkg: "botpack", skin: "xan" },
  { id: "skaarj", mesh: "TSkM", pkg: "bonus", skin: "skrilax" },
  { id: "nali", mesh: "tnalimesh", pkg: "bonus", skin: "default" },
  { id: "warcow", mesh: "TCowMesh", pkg: "bonus", skin: "default" },
];

// glTF clip name -> UT99 sequence name. See WHICH SIX SEQUENCES in the header: these are
// the small-weapon variants, because everyone here carries the Enforcer.
//
// `hold` means the clip is that sequence's FIRST FRAME and nothing else — UnrealScript's
// TweenAnim, which blends to frame 0 and stops. Only the idle is like that, and it is the
// whole reason this list is not "play StillSmFr on a loop".
const CLIPS = [
  { name: "Idle", seq: "StillSmFr", hold: true },
  { name: "Walk", seq: "WalkSm", loop: true },
  { name: "Run", seq: "RunSm", loop: true },
  { name: "Fire", seq: "StillSmFr" },
  { name: "WalkFire", seq: "WalkSmFr", loop: true },
  { name: "RunFire", seq: "RunSmFr", loop: true },
];

const pkgs = Object.fromEntries(
  Object.entries(PACKAGES).map(([key, file]) => {
    const p = path.join(SYSTEM, file);
    if (!fs.existsSync(p)) {
      console.error(`no such file: ${p}`);
      console.error(
        `this tool needs a retail UT99 install; pass the System directory as an argument.`,
      );
      process.exit(1);
    }
    return [key, loadPackage(fs.readFileSync(p))];
  }),
);

// ---------------------------------------------------------------------------
// THE MESH -> WORLD TRANSFORM
// ---------------------------------------------------------------------------

/** A UE1 rotator component (65536 to the turn) as degrees. */
const rotDeg = (units) => (units * 360) / 65536;
const r4 = (n) => Math.round(n * 10000) / 10000;
const r6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * UE1's FRotationMatrix for a rotator, in degrees. Rows are the rotated frame's axes.
 *
 * Kept in this row shape, exactly as build-ut-viewmodels.mjs does, because that is what
 * makes the transpose below obviously the right thing rather than a lucky sign flip.
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

/**
 * How many UT99 frames a clip actually shows.
 *
 * The whole sequence, except for a `hold` clip — UnrealScript's TweenAnim blends to a
 * sequence's FIRST frame and stops there with AnimRate 0, so the armed idle is one frame
 * of StillSmFr and the seven after it are a recoil nobody asked for. See the header.
 */
const frameCount = (c) => (c.hold ? 1 : c.s.numFrames);

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (v) => {
  const n = Math.hypot(...v);
  if (!(n > 1e-9)) throw new Error(`cannot normalise ${v.join(", ")}`);
  return v.map((c) => c / n);
};

/**
 * A glTF quaternion [x, y, z, w] from a rotation matrix given as its three COLUMNS.
 *
 * Shepperd's method: pick the largest of the four diagonal combinations so the divisor is
 * never near zero. Doing it the naive way (always from the trace) loses all precision on a
 * 180-degree turn, and a pawn's hand goes through most of a turn over a stride.
 */
function quatFromCols(cx, cy, cz) {
  const m = [
    [cx[0], cy[0], cz[0]],
    [cx[1], cy[1], cz[1]],
    [cx[2], cy[2], cz[2]],
  ];
  const t = m[0][0] + m[1][1] + m[2][2];
  let q;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    q = [(m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s, s / 4];
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    q = [s / 4, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s, (m[2][1] - m[1][2]) / s];
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    q = [(m[0][1] + m[1][0]) / s, s / 4, (m[1][2] + m[2][1]) / s, (m[0][2] - m[2][0]) / s];
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    q = [(m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, s / 4, (m[1][0] - m[0][1]) / s];
  }
  const n = Math.hypot(...q);
  return q.map((c) => c / n);
}

const transpose = (m) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => m[j][i]));
const matMul = (a, b) =>
  a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const apply = (m, v) => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
const det3 = (m) =>
  m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
  m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
  m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

// UT axes (x forward, y right, z up) -> the world frame the client draws in (x right,
// y up, z BACK, so forward is -z, which is what the rig's yaw is measured against).
// Determinant -1, so winding reverses — derived, not assumed, where the indices are built.
const UT_TO_WORLD = [
  [0, 1, 0],
  [0, 0, 1],
  [-1, 0, 0],
];

/**
 * The mesh-local -> world matrix for one mesh, in metres per raw vertex unit.
 *
 * `k` folds Mesh.Scale and UU_TO_M together. Mesh.Origin is NOT in here: it is subtracted
 * from the raw vertex before this is applied (see the header — UE1 subtracts it in
 * unscaled units) and vertexAt() below is the only place vertices are read.
 */
function worldMatrix(mesh) {
  const scale = [
    [mesh.scale[0] * UU_TO_M, 0, 0],
    [0, mesh.scale[1] * UU_TO_M, 0],
    [0, 0, mesh.scale[2] * UU_TO_M],
  ];
  const [pitch, yaw, roll] = mesh.rotOrigin.map(rotDeg);
  return matMul(UT_TO_WORLD, matMul(transpose(rotationMatrix(pitch, yaw, roll)), scale));
}

/**
 * The signed volume the emitted triangles enclose, as glTF reads them.
 *
 * glTF front faces are counter-clockwise seen from outside, so a closed mesh wound that way
 * has POSITIVE signed volume about an interior point. A UT99 body is closed enough for the
 * sign not to be in doubt. Checked rather than reasoned about, because a coordinate swap
 * with determinant -1 reverses winding and "it used to work" is not evidence about a
 * different swap: the volume test and the determinant have to agree or the build stops.
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

/**
 * Which way a body is running, in degrees off -Z, read off its own Run cycle.
 *
 * A planted foot does not move relative to the ground, so in a treadmill animation — which
 * every UT99 run cycle is, the pawn stays at the origin and the world is what moves — the
 * planted foot slides BACKWARDS through the mesh at exactly the speed the body is going
 * forwards. Sum that backwards slide over the cycle and negate it and you have the
 * direction the body faces, with no reliance on where the arms are or which boot is in
 * front, which is what the discredited feet-direction heuristic relied on.
 *
 * "Low" is the bottom 6% of the standing height in the cycle's first frame — the boots.
 * "Planted" is a low vertex that is within 4% of the minimum height in the frame it is
 * moving out of; a foot in mid-swing is higher than that and contributes nothing.
 *
 * `frames` is an array of frames, each an array of [x, y, z] in the world frame (y up).
 */
function runHeading(frames) {
  const ys = frames[0].map((p) => p[1]);
  const minY = Math.min(...ys);
  const height = Math.max(...ys) - minY;
  const lowCut = minY + height * 0.06;
  const plantCut = minY + height * 0.04;
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (let k = 0; k < frames.length; k++) {
    const a = frames[k];
    const b = frames[(k + 1) % frames.length];
    for (let i = 0; i < a.length; i++) {
      if (frames[0][i][1] > lowCut) continue; // not a boot
      if (a[i][1] > plantCut) continue; // that boot is in the air this frame
      sx += b[i][0] - a[i][0];
      sz += b[i][2] - a[i][2];
      n++;
    }
  }
  if (!n) throw new Error("no planted foot vertices in the run cycle");
  // Negated: the ground slides back, the body goes forward. Forward is -Z, so the heading
  // is the angle of (fx, -fz) — zero means dead along -Z.
  const [fx, fz] = [-sx, -sz];
  return {
    deg: (Math.atan2(fx, -fz) * 180) / Math.PI,
    magnitude: Math.hypot(fx, fz),
    samples: n,
  };
}

// ---------------------------------------------------------------------------
// BUILD
// ---------------------------------------------------------------------------

const rows = [];
for (const spec of CHARACTERS) {
  rows.push(buildCharacter(spec));
}

console.log(
  `\n${"model".padEnd(10)} ${"mesh".padEnd(10)} ${"idle".padEnd(10)} ` +
    `wedges  slots  targets   scale   run deg   feet dip   bin   gun hand (m)         swing`,
);
for (const r of rows) {
  console.log(
    `${r.id.padEnd(10)} ${r.mesh.padEnd(10)} ${r.idleSeq.padEnd(10)} ` +
      `${String(r.wedges).padStart(6)}  ${String(r.slots).padStart(5)}  ` +
      `${String(r.targets).padStart(7)}  ${r.fit.toFixed(4)}  ` +
      `${r.heading.toFixed(2).padStart(7)}  ${(r.feetDip * 1000).toFixed(1).padStart(7)} mm  ` +
      `${(r.binBytes / 1024).toFixed(0)}K  ` +
      `${r.anchor.map((v) => v.toFixed(3).padStart(6)).join(",")}  ` +
      `${(r.anchorSwing * 100).toFixed(1).padStart(5)} cm`,
  );
}
console.log(
  `\nclips: ${CLIPS.map((c) => `${c.name}=${c.seq}${c.hold ? "[0]" : ""}`).join("  ")}\n` +
    `run deg is degrees off -Z, measured on the emitted geometry's own Run clip.\n` +
    `feet dip is how far the lowest vertex of the Run clip goes below y = 0, where 0 is ` +
    `the Idle clip's first frame.\nNow run: node scripts/gen-characters.mjs`,
);

/** One character: mesh -> <id>.gltf + <id>.bin, in place, with the six clips above. */
function buildCharacter(spec) {
  const pkg = pkgs[spec.pkg];
  const mesh = readMesh(pkg, spec.mesh);
  const dir = path.join(OUT_DIR, spec.id);
  if (!fs.existsSync(dir)) throw new Error(`${spec.id}: ${path.relative(ROOT, dir)} does not exist`);

  const M = worldMatrix(mesh);
  const O = mesh.origin;
  // A frame's real geometry, in metres in the world frame, before the standing-height fit
  // and before the lift onto the floor. `specialVerts` of every frame are UT's weapon
  // anchors rather than geometry and are dropped by every caller through this one function.
  const rawFrame = (f) =>
    mesh
      .frame(f)
      .slice(mesh.specialVerts)
      .map((v) => apply(M, [v[0] - O[0], v[1] - O[1], v[2] - O[2]]));

  const seqFor = (name) => {
    const s = mesh.anims.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (!s) {
      throw new Error(
        `${spec.mesh}: no sequence "${name}" — has ${mesh.anims.map((a) => a.name).join(", ")}`,
      );
    }
    if (!(s.rate > 0)) throw new Error(`${spec.mesh}.${name}: rate is ${s.rate}`);
    return s;
  };
  const seqs = CLIPS.map((c) => ({ ...c, s: seqFor(c.seq) }));
  const idle = seqs[0];
  const baseFrame = idle.s.startFrame;

  // --- standing height and the lift onto the floor -----------------------
  // Both are read off the Idle clip's FIRST frame, which is also the base pose: it is the
  // one frame the model shows with all morph weights at zero, so it is the frame "standing
  // 1.830 m tall with its boots on the floor" has to be true of.
  const rawBase = rawFrame(baseFrame);
  const baseYs = rawBase.map((p) => p[1]);
  const rawHeight = Math.max(...baseYs) - Math.min(...baseYs);
  if (!(rawHeight > 0.5)) throw new Error(`${spec.id}: idle pose is ${rawHeight.toFixed(3)} m tall`);
  const fit = STANDING_HEIGHT_M / rawHeight;
  const lift = -Math.min(...baseYs) * fit;
  const posAt = (f) => rawFrame(f).map((p) => [p[0] * fit, p[1] * fit + lift, p[2] * fit]);
  const basePos = posAt(baseFrame);

  // --- the weapon anchor: Epic's own three special vertices --------------
  // Every UT99 pawn mesh carries THREE "special" vertices in front of its geometry
  // (umesh.mjs reports specialVerts = 3 on all eight; a weapon mesh has none). They are
  // not geometry — nothing references them — they are the weapon attachment, and measured
  // on the emitted bodies they bracket the gun hand: V0 sits about a hand ABOVE the fist,
  // V2 the same distance BELOW it, and V1 is out along the aim, 0.46 to 0.65 m forward.
  //
  // So the hand is the V0-V2 midpoint, and that is what a third-person weapon has to hang
  // from. Measured against each body's own fist (the forward-most cluster of its upper
  // body in this pose), the midpoint lands within 4.8-8.6 cm on all six humanoids, where
  // the actor origin — which is where UE1 was assumed to draw the carried weapon — is
  // 49-75 cm out, down at the hip where the hand hangs with the arms DOWN.
  //
  // The Nali (25 cm) and the cow (61 cm) are outliers and are emitted anyway: a Nali has
  // four arms and a cow has none, so there is no fist for the anchor to agree with.
  //
  // It is emitted for the BASE frame only. The real anchor moves with the hand through
  // Walk, Run and Fire, which a static number cannot follow — see the doc.
  const specialAt = (f) =>
    mesh
      .frame(f)
      .slice(0, mesh.specialVerts)
      .map((v) => apply(M, [v[0] - O[0], v[1] - O[1], v[2] - O[2]]))
      .map((p) => [p[0] * fit, p[1] * fit + lift, p[2] * fit]);
  const special = specialAt(baseFrame);
  if (special.length !== 3) {
    throw new Error(`${spec.id}: ${special.length} special vertices, not the pawn's 3`);
  }

  /**
   * The weapon attachment for one frame: where the hand is, and which way it is holding.
   *
   * UE1 renders a carried item AT this frame with THIS frame's orientation, so both halves
   * are needed and both move — the triangle swings with the arm through a stride.
   *
   *   position     the V0-V2 midpoint, i.e. the middle of the fist
   *   forward      V1 - V0, the aim; the weapon's own -Z is laid along it
   *   up           V0 - V2, orthogonalised against forward
   *
   * The basis is built z-first so it is orthonormal and right-handed whatever rounding the
   * three vertices carry: z = -forward (the weapon points -Z, so its +Z is backwards),
   * x = up x z, y = z x x. For a body standing square that comes out as the identity, which
   * is the check the build makes on the base pose below.
   */
  const anchorAt = (f) => {
    const [v0, v1, v2] = specialAt(f);
    const pos = [0, 1, 2].map((a) => (v0[a] + v2[a]) / 2);
    const fwd = norm([0, 1, 2].map((a) => v1[a] - v0[a]));
    const up = norm([0, 1, 2].map((a) => v0[a] - v2[a]));
    const z = fwd.map((c) => -c);
    const x = norm(cross(up, z));
    const y = cross(z, x);
    // Columns are the images of the local axes, which is what a rotation matrix is.
    return { pos, quat: quatFromCols(x, y, z) };
  };
  const baseAnchor = anchorAt(baseFrame);
  const weaponAnchor = baseAnchor.pos;
  // How far the hand travels over a run cycle, which is the whole reason the anchor is a
  // track rather than a number: a gun pinned to the base pose would float beside a running
  // body by this much. Reported, not enforced — it is Epic's stride, not a tolerance.
  const anchorSwing = (() => {
    const run = seqs.find((c) => c.name === "Run").s;
    const pts = [];
    for (let i = 0; i < run.numFrames; i++) pts.push(anchorAt(run.startFrame + i).pos);
    let d = 0;
    for (const a of pts) {
      for (const b of pts) d = Math.max(d, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    return d;
  })();

  // --- self-check: is this thing standing up, over its own cylinder? -----
  // The tallest axis of a standing body is up, and after UT_TO_WORLD up is Y. If the
  // rotator went in the wrong way round this is what catches it first.
  {
    const ext = [0, 1, 2].map(
      (a) => Math.max(...basePos.map((p) => p[a])) - Math.min(...basePos.map((p) => p[a])),
    );
    if (ext.indexOf(Math.max(...ext)) !== 1) {
      throw new Error(
        `${spec.id}: tallest along ${"XYZ"[ext.indexOf(Math.max(...ext))]}, not Y — ` +
          `it is not standing up (${ext.map((v) => v.toFixed(3)).join(" x ")} m)`,
      );
    }
  }
  // Where the boots sit relative to the actor's cylinder axis, in Unreal Units, so the
  // Mesh.Origin decision above stays checkable. Reported rather than enforced: a Skaarj
  // leans forward and its feet genuinely trail its axis.
  const feetOffsetUU = (() => {
    const ys = rawBase.map((p) => p[1]);
    const [lo, hi] = [Math.min(...ys), Math.max(...ys)];
    const feet = rawBase.filter((p) => p[1] < lo + (hi - lo) * 0.08);
    return [0, 2].map((a) => feet.reduce((t, p) => t + p[a], 0) / feet.length / UU_TO_M);
  })();

  // --- self-check: which way does it run? --------------------------------
  // The bug this whole rebuild exists for, measured on the geometry about to be written.
  const runFrames = [];
  for (let i = 0; i < seqs[2].s.numFrames; i++) runFrames.push(posAt(seqs[2].s.startFrame + i));
  const heading = runHeading(runFrames);
  if (Math.abs(heading.deg) > 2) {
    throw new Error(
      `${spec.id}: runs ${heading.deg.toFixed(1)} degrees off -Z — the body does not face ` +
        `the way the rig does (${heading.samples} planted samples)`,
    );
  }
  // How far the planted foot sinks below the floor during the run. Not a fault: the base
  // pose is an idle stance and a running stride reaches lower. Reported so it stays visible.
  const feetDip = Math.max(0, -Math.min(...runFrames.flat().map((p) => p[1])));

  // --- geometry ----------------------------------------------------------
  // Wedges are per-corner already (a vertex index plus a UV), so they map one to one onto
  // glTF vertices and nothing needs splitting. One shared POSITION for the whole body, one
  // index accessor per material slot.
  const positions = [];
  const uvs = [];
  for (const w of mesh.wedges) {
    const p = basePos[w.v];
    if (!p) throw new Error(`${spec.id}: wedge points at vertex ${w.v} of ${basePos.length}`);
    positions.push(...p);
    uvs.push(w.u / 256, w.vv / 256);
  }

  const groups = new Map();
  for (const f of mesh.faces) {
    if (!groups.has(f.material)) groups.set(f.material, []);
    groups.get(f.material).push(...f.w);
  }
  const slots = [...groups.entries()].sort((a, b) => a[0] - b[0]);

  // --- the slot check, against the file about to be overwritten ----------
  verifySlots(spec, dir, slots);

  // --- winding -----------------------------------------------------------
  const flat = slots.flatMap(([, idx]) => idx);
  const asIs = signedVolume(positions, flat);
  const reversed = signedVolume(
    positions,
    flat.map((_, i, a) => a[i - (i % 3) + [0, 2, 1][i % 3]]),
  );
  if (!(asIs * reversed < 0)) {
    throw new Error(`${spec.id}: winding test is not decisive (${asIs} vs ${reversed})`);
  }
  const flip = reversed > asIs;
  if (flip !== det3(M) < 0) {
    throw new Error(
      `${spec.id}: winding disagrees with the transform's determinant ` +
        `(det ${det3(M)}, volumes ${asIs} / ${reversed})`,
    );
  }
  const order = flip ? [0, 2, 1] : [0, 1, 2];

  // --- morph targets: one per unique frame any clip touches --------------
  // `hold` clips touch one frame, not the sequence's whole span. The idle is the only one,
  // and since its frame IS the base frame it adds nothing here either way — but asking
  // frameCount() in both places keeps "how long is this clip" one answer.
  const wanted = new Set();
  for (const c of seqs) for (let i = 0; i < frameCount(c); i++) wanted.add(c.s.startFrame + i);
  wanted.delete(baseFrame); // its delta is zero, and all-zero weights already mean the base
  const frames = [...wanted].sort((a, b) => a - b);
  const targetOf = new Map(frames.map((f, i) => [f, i]));

  // --- buffer ------------------------------------------------------------
  const parts = [];
  const bufferViews = [];
  const accessors = [];
  let offset = 0;
  const pad = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
  const push = (buf, target) => {
    parts.push(pad(buf));
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: buf.length,
      ...(target ? { target } : {}),
    });
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

  const targets = [];
  for (const f of frames) {
    const fp = posAt(f);
    const delta = new Float32Array(mesh.wedges.length * 3);
    mesh.wedges.forEach((w, i) => {
      const a = fp[w.v];
      const b = basePos[w.v];
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
  // Material slot i -> image i -> s{i}.png. Positional, because a pawn mesh's textures are
  // empty names that UT99 fills in at runtime from MultiSkins; verifySlots() has already
  // insisted this ordering is the one the committed skins were cut for.
  const primitives = [];
  const materials = [];
  const images = [];
  const textures = [];
  for (const [matIndex, wedgeIdx] of slots) {
    const file = `${spec.skin}/s${materials.length}.png`;
    if (!fs.existsSync(path.join(dir, file))) {
      throw new Error(`${spec.id}: material slot ${materials.length} has no ${file}`);
    }
    images.push({ uri: file });
    textures.push({ source: images.length - 1, sampler: 0 });
    const flags = mesh.materials[matIndex].polyFlags;
    materials.push({
      // remote-avatar.js and the AR players table both read the slot number off this
      // name — /slot(\d+)$/ — and hang the variant's texture on it. Renaming these
      // silently un-skins every character.
      name: `slot${materials.length}`,
      ...((flags & PF_TWOSIDED) !== 0 ? { doubleSided: true } : {}),
      pbrMetallicRoughness: {
        baseColorTexture: { index: textures.length - 1 },
        metallicFactor: 0,
        roughnessFactor: 1,
      },
    });

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
      material: materials.length - 1,
      // Every primitive carries the same target set: three.js and the glTF spec both
      // require the count to match across a mesh's primitives, and a missing set on one
      // leaves that body part frozen while the rest of the model runs.
      ...(targets.length ? { targets } : {}),
    });
  }

  // --- animations --------------------------------------------------------
  const animations = [];
  const clipInfo = [];
  for (const c of seqs) {
    const s = c.s;
    const n = frameCount(c);
    const keys = [];
    const weights = [];
    // The UT99 frame each key shows, so the weapon anchor can be sampled at exactly the
    // times the body is — one key, one pose, one hand position.
    const keyFrames = [];
    const one = (frame) => {
      const row = new Array(targets.length).fill(0);
      const t = targetOf.get(frame);
      if (t !== undefined) row[t] = 1;
      return row;
    };
    for (let i = 0; i < n; i++) {
      keys.push(i / s.rate);
      weights.push(...one(s.startFrame + i));
      keyFrames.push(s.startFrame + i);
    }
    if (n === 1) {
      // Either a HELD clip (the idle, on every model) or a genuinely one-frame sequence
      // (tnalimesh's StillSmFr, so the Nali's Fire too). A sampler with a single key has
      // zero duration and some importers reject it, so it gets a second identical key.
      keys.push(1 / s.rate);
      weights.push(...one(s.startFrame));
      keyFrames.push(s.startFrame);
    } else if (c.loop) {
      // A looping clip has to arrive back where it started or the wrap is a jump.
      keys.push(n / s.rate);
      weights.push(...one(s.startFrame));
      keyFrames.push(s.startFrame);
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
    // --- the weapon anchor, sampled at the same instants -----------------
    // UE1 draws a carried item AT the pawn's weapon triangle WITH that triangle's
    // orientation, and the triangle is per-frame data: the hand swings through a stride and
    // the gun swings with it. So the anchor is not one number on the model, it is a
    // translation and a rotation track on every clip, keyed frame for frame against the
    // weights track above.
    const anchorPos = [];
    const anchorQuat = [];
    for (const f of keyFrames) {
      const { pos, quat } = anchorAt(f);
      anchorPos.push(...pos);
      // q and -q are the same rotation, but a LINEAR sampler interpolates the COMPONENTS,
      // so a sign flip between adjacent keys takes the long way round — a hand that spins
      // through 300 degrees in one frame. Keep every key in the same hemisphere as the last.
      const prev = anchorQuat.slice(-4);
      const dot = prev.length ? prev.reduce((t, v, i) => t + v * quat[i], 0) : 1;
      anchorQuat.push(...(dot < 0 ? quat.map((v) => -v) : quat));
    }
    const posOut = accessors.length;
    accessors.push({
      bufferView: push(Buffer.from(new Float32Array(anchorPos).buffer)),
      componentType: 5126,
      count: keys.length,
      type: "VEC3",
      ...minMax(anchorPos, 3),
    });
    const rotOut = accessors.length;
    accessors.push({
      bufferView: push(Buffer.from(new Float32Array(anchorQuat).buffer)),
      componentType: 5126,
      count: keys.length,
      type: "VEC4",
    });

    animations.push({
      name: c.name,
      // LINEAR, not STEP: UE1 tweens between frames, so a linear ramp between adjacent
      // one-hot weight vectors is what UT99 actually draws.
      samplers: [
        { input, output, interpolation: "LINEAR" },
        { input, output: posOut, interpolation: "LINEAR" },
        { input, output: rotOut, interpolation: "LINEAR" },
      ],
      // The WEIGHTS channel stays first. scripts/render-characters.mjs and
      // server/test/characters.test.mjs both read channels[0] to get at the pose, and a
      // reordering here would silently hand them the anchor instead.
      channels: [
        { sampler: 0, target: { node: 0, path: "weights" } },
        { sampler: 1, target: { node: ANCHOR_NODE, path: "translation" } },
        { sampler: 2, target: { node: ANCHOR_NODE, path: "rotation" } },
      ],
    });
    clipInfo.push({
      clip: c.name,
      sequence: s.name,
      startFrame: s.startFrame,
      // What the CLIP is, which for the idle is not what the sequence is: one frame of
      // eight. sequenceFrames keeps the difference visible rather than letting the idle
      // look like a truncated read of StillSmFr.
      numFrames: n,
      sequenceFrames: s.numFrames,
      fps: r4(s.rate),
      seconds: r4(n / s.rate),
      loop: !!c.loop,
      ...(c.hold ? { hold: true } : {}),
    });
  }

  const bin = Buffer.concat(parts);
  fs.writeFileSync(path.join(dir, `${spec.id}.bin`), bin);

  const [pitch, yaw, roll] = mesh.rotOrigin.map(rotDeg);
  const gltf = {
    asset: { version: "2.0", generator: "build-ut-characters.mjs" },
    extras: {
      // Written from here so that a future disagreement with a measurement taken off the
      // geometry is visible rather than silent — server/test/characters.test.mjs measures
      // rather than reads.
      utMesh: spec.mesh,
      utPackage: PACKAGES[spec.pkg],
      baseSequence: idle.s.name,
      baseFrame,
      worldFrame: "forward -Z, up +Y, right +X; feet on y = 0; RotOrigin baked in",
      epicRotOriginDeg: [r4(pitch), r4(yaw), r4(roll)],
      meshOriginUU: mesh.origin.map(r4),
      orientationNote:
        "Vertices are mesh-frame, so they reach the actor frame through the TRANSPOSE of " +
        "UE1's FRotationMatrix(RotOrigin), with Mesh.Origin subtracted before Mesh.Scale. " +
        "UE1 pawns face +X, so through UT (x fwd, y right, z up) -> world (x right, y up, " +
        "z back) every body faces -Z with no per-model yaw. See scripts/build-ut-characters.mjs.",
      standingHeightM: STANDING_HEIGHT_M,
      // What the mesh measures at true UT99 pawn scale, and the uniform factor that put it
      // on the shared 39-unit collision cylinder. The one fitted number in this file.
      utHeightM: r4(rawHeight),
      heightFit: r6(fit),
      // How far the body was lifted to put the Idle pose's lowest vertex on y = 0. The
      // third-person weapons cannot know it — a weapon has no wearer — so they are lifted
      // by the nominal 39 * UU_TO_M instead and this is what the difference is measured
      // against. See scripts/build-ut-thirdperson.mjs.
      feetLiftM: r6(lift),
      // Where this body's gun hand is, in the same metres the glTF is in, and the three
      // vertices it is derived from. See the weapon-anchor block in this script: it is the
      // midpoint of Epic's own weapon-attachment triangle, and it is what
      // scripts/build-ut-thirdperson.mjs and gen-characters.mjs both read.
      weaponAnchorM: weaponAnchor.map(r6),
      weaponAnchorQuat: baseAnchor.quat.map(r6),
      weaponAnchorNode: ANCHOR_NAME,
      specialVertsM: special.map((p) => p.map(r6)),
      weaponAnchorNote:
        "The node named " + ANCHOR_NAME + " carries this as its rest transform AND a " +
        "translation + rotation track on every clip, keyed against that clip's weights. " +
        "UE1 draws a carried item at the pawn's weapon triangle with the triangle's own " +
        "orientation, and the triangle is per-frame data, so the hand swings with the arm.",
      runHeadingDeg: r4(heading.deg),
      feetDipM: r6(feetDip),
      feetOffsetUU: feetOffsetUU.map(r4),
      collisionHeightUU: COLLISION_HEIGHT_UU,
      clips: clipInfo,
    },
    scene: 0,
    scenes: [{ nodes: [0, ANCHOR_NODE] }],
    nodes: [
      { mesh: 0, name: spec.mesh },
      {
        // WHERE THE GUN GOES. An empty node, a SIBLING of the mesh rather than a child, so
        // its local transform is already in the same space as the body's vertices and a
        // client can parent a weapon to it with nothing to compose. Every clip animates it.
        // Its resting transform is the base pose's, so a model shown with no clip playing
        // still holds its weapon in the right place.
        name: ANCHOR_NAME,
        translation: baseAnchor.pos.map(r6),
        rotation: baseAnchor.quat.map(r6),
      },
    ],
    meshes: [
      {
        name: spec.id,
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
    buffers: [{ uri: `${spec.id}.bin`, byteLength: bin.length }],
    animations,
  };
  fs.writeFileSync(path.join(dir, `${spec.id}.gltf`), JSON.stringify(gltf, null, 1) + "\n");

  return {
    id: spec.id,
    mesh: spec.mesh,
    idleSeq: idle.s.name,
    wedges: mesh.wedges.length,
    slots: materials.length,
    targets: targets.length,
    fit,
    heading: heading.deg,
    feetDip,
    anchor: weaponAnchor,
    anchorSwing,
    binBytes: bin.length,
  };
}

/**
 * Refuse to overwrite a body whose material slots do not line up with the committed skins.
 *
 * The skins are not being re-extracted, so slot i has to keep meaning what s{i}.png was cut
 * for. Both halves of that are checked against the file on disk: the number of triangles in
 * the slot, and the number of DISTINCT mesh vertices those triangles touch. The old
 * extractor gave each slot its own POSITION accessor, so its vertex count is that distinct
 * count; this one shares a single POSITION across the body, so the counts are compared that
 * way rather than accessor to accessor.
 */
function verifySlots(spec, dir, slots) {
  const file = path.join(dir, `${spec.id}.gltf`);
  if (!fs.existsSync(file)) {
    console.log(`${spec.id}: no existing glTF to verify against — writing fresh.`);
    return;
  }
  const old = JSON.parse(fs.readFileSync(file, "utf8"));
  const prev = old.meshes?.[0]?.primitives || [];
  const want = slots.map(([, idx]) => ({ tris: idx.length, verts: new Set(idx).size }));
  const have = prev.map((p) => ({
    tris: old.accessors[p.indices].count,
    // A previous build of THIS script shares one POSITION accessor across every slot, so
    // fall back to counting what the slot's own indices touch.
    verts: (() => {
      const shared = prev.every(
        (q) => q.attributes.POSITION === prev[0].attributes.POSITION,
      );
      return shared ? null : old.accessors[p.attributes.POSITION].count;
    })(),
  }));
  const problems = [];
  if (want.length !== have.length) {
    problems.push(`${want.length} material slots against ${have.length} in the committed file`);
  }
  want.forEach((w, i) => {
    const h = have[i];
    if (!h) return;
    if (w.tris !== h.tris) problems.push(`slot ${i}: ${w.tris} indices against ${h.tris}`);
    if (h.verts !== null && w.verts !== h.verts) {
      problems.push(`slot ${i}: ${w.verts} distinct vertices against ${h.verts}`);
    }
  });
  if (problems.length) {
    throw new Error(
      `${spec.id}: material slots do not match the committed glTF, so the committed skins ` +
        `would land on the wrong body parts — ${problems.join("; ")}`,
    );
  }
}
