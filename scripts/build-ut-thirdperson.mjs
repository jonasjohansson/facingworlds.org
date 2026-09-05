#!/usr/bin/env node
// build-ut-thirdperson.mjs — the six weapons as ONLOOKERS see them: the gun in the other
// player's hands, not the gun in yours.
//
//   node scripts/build-ut-thirdperson.mjs [path-to-UT-System]
//
// DEV TOOLING, like build-ut-viewmodels.mjs and build-ut-characters.mjs: it needs a retail
// install, so it is not part of any build. It writes assets/3d/thirdperson/<id>/ and
// scripts/data/ut-thirdperson.json, and those are committed.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A SEPARATE MESH AND NOT THE ONE NEXT DOOR
// ---------------------------------------------------------------------------
// UT99 ships TWO models per weapon and they are not interchangeable. Engine.Inventory:
//
//     var() mesh  PlayerViewMesh;     var() float PlayerViewScale;    // yours
//     var() mesh  ThirdPersonMesh;    var() float ThirdPersonScale;   // everyone else's
//
// The view mesh is a gun and a forearm framed for a camera 8 cm away and drawn through
// UE1's own view projection — scripts/build-ut-viewmodels.mjs extracts those, at 0.12 to
// 0.20 m across, and the client draws them in front of the eye at a fitted display scale.
// Putting one of those in a remote avatar's hand would be putting a 12 cm toy there.
//
// The third-person mesh is the same weapon authored at WORLD scale, with a whole arm on
// it, meant to be seen from across a map. Inventory replicates exactly the two properties
// it needs (Inventory.uc's replication block names ThirdPersonMesh and ThirdPersonScale),
// and UE1 draws the carried item — BecomeItem sets bCarriedItem = true — on the OWNER
// PAWN's Location and Rotation. Location is the CENTRE of the pawn's collision cylinder,
// so the mesh's own Origin, RotOrigin and Scale are the entire placement: they are what
// puts the gun out at the end of an arm rather than inside the pawn's chest.
//
// ThirdPersonScale is 1 on all six. It is read rather than assumed, because reading it as
// 0 (the value an unset property reports) would collapse a weapon to a point.
//
// ---------------------------------------------------------------------------
// THE TRANSFORM IS THE CHARACTERS' TRANSFORM, UNCHANGED
// ---------------------------------------------------------------------------
// This is the point of doing it here rather than by eye in the client. The gun and the
// body have to land in the same frame, so they go through the same three steps, which
// scripts/build-ut-characters.mjs derived and pinned:
//
//   1. (V - Mesh.Origin) x Mesh.Scale — Origin subtracted in RAW packed vertex units,
//      BEFORE the scale. Measured there on eight pawns; the same order is used here.
//   2. x the TRANSPOSE of UE1's FRotationMatrix(RotOrigin). Its ROWS are the rotated
//      frame's axes in the parent frame, so M^T takes mesh components to ACTOR components.
//   3. x UT_TO_WORLD (x_world = UT y, y_world = UT z, z_world = -UT x), so forward is -Z,
//      up is +Y, right is +X. Determinant -1, so winding is re-derived, not assumed.
//
// x UU_TO_M x ThirdPersonScale for the metres, and then ONE more thing, which is the only
// place this file differs from the character build.
//
// ---------------------------------------------------------------------------
// THE LIFT — AND WHY IT IS NOT THE WHOLE PLACEMENT
// ---------------------------------------------------------------------------
// After the transform both a body and a gun are in ACTOR space, where y = 0 is the middle
// of the collision cylinder. The game's rig is the FLOOR, so both have to come up. A
// character knows how far — build-ut-characters.mjs lifts each body until its own idle
// pose stands on y = 0 — but a WEAPON CANNOT KNOW ITS WEARER: there is one enforcer.gltf
// and eight bodies that might be holding it. So it is lifted by the NOMINAL half height,
// 39 UU x UU_TO_M = 0.9165 m, and the geometry here ends up sitting at the pawn's ACTOR
// ORIGIN, which is the middle of its chest at the centre line.
//
// That is not where a hand is, and the first version of this script stopped there. Drawn
// against the Soldier, the gun landed 42 cm below and 43 cm behind his fist — down at the
// hip, which is exactly where the hand hangs when the arm is DOWN. Measured on all six of
// UT99's own pawn poses, the frames whose fist sits at that spot are Look, LookL and
// Dead4. In a picture it is unmistakable: the pistol floats by the thigh while both arms
// are held out in front.
//
// EPIC'S ANSWER IS IN THE PAWN MESH. Every UT99 player mesh carries THREE "special"
// vertices ahead of its geometry (scripts/lib/umesh.mjs reports specialVerts = 3 on all
// eight bodies and 0 on every one of these weapons). Nothing references them — no wedge,
// no face — because they are not geometry: they are the weapon attachment. Emitted through
// the same transform as the body, they BRACKET the gun hand:
//
//     soldier   V0 (0.140, 1.528, -0.433)   V1 -0.65 m forward   V2 0.38 m below V0
//
// V0 sits about a hand above the fist, V2 the same below it, and V1 is out along the aim.
// So the hand is the V0-V2 MIDPOINT, and build-ut-characters.mjs writes it into each body
// as extras.weaponAnchorM. Grip-to-fist distance, measured against each body's own
// forward-most upper-body cluster, over every rule that was tried:
//
//     rule                                soldier commando  boss  fcomm  sgirl  skaarj
//     actor origin (what shipped first)      56.4     49.5   51.1   71.0   74.7    72.1
//     V0 alone                               15.6     15.7   12.4   13.2   13.9    12.0
//     V0-V2 midpoint                          5.4      4.8    5.6    7.8    8.6     7.1
//
// and (V*S - O), (V*S), (V+O)*S and "also apply the pawn's own Mesh.Origin" were all
// worse than the first row. The midpoint is what is used.
//
// TWO HONEST CAVEATS. The Nali is 25 cm out and the cow 61 cm, and neither is a surprise:
// a Nali has four arms and a cow has none, so there is no fist for an anchor to agree
// with. And this is a BASE-POSE number — the real hand swings through Walk, Run and Fire,
// which one vector cannot follow. Following it would mean a per-frame anchor, which is a
// bigger change to what the client is handed than this pipeline should make on its own.
//
// The anchor minus the nominal lift is emitted per model as pawnAnchor.offsetM, and the
// generated src/shared/characters.js carries the same vector as weaponOffsetM /
// weaponOffset(index) — the copy the browser can actually load. A client parents a weapon
// to an avatar and adds one vector.
//
// ---------------------------------------------------------------------------
// WHICH ANIMATIONS
// ---------------------------------------------------------------------------
// Two of the six third-person meshes move at all. Every one carries an 'All' sequence
// (UE1's catch-all span over every frame) and five carry a one-frame 'Still'; those two
// names are the resting pose, not animation, so they are not emitted as clips. What is
// left is:
//
//     AutoHand    Shoot  frames 1-6 @ 30      shot2  frames 1-6 @ 30
//     ASMD2hand   Fire1  frames 1-9 @ 24      Fire2  frames 1-9 @ 24
//
// and the other four (RifleHand, EightHand, Razor3rd2, WHHand) are a single frame each —
// a UT99 sniper rifle does not move in anyone else's hands.
//
// WHAT PLAYS THEM is not a second set of rules. A weapon actor has ONE AnimSequence, and
// UE1 plays it on whichever mesh that actor is currently drawing: your PlayerViewMesh for
// you, its ThirdPersonMesh for everyone else. So enforcer.PlayFiring's PlayAnim('Shoot',
// 0.5 + 0.31 * FireAdjust) is what onlookers see on AutoHand, at the same multiplier,
// because the two meshes name their sequences the same way. The multipliers are therefore
// taken from scripts/data/ut-viewmodels.json BY CLIP NAME rather than restated here: one
// place holds "what UnrealScript passes to PlayAnim", and a name that stops matching is a
// build error rather than two files quietly drifting apart.
//
// ASMD2hand's 'Fire2' has no name in that plan — ShockRifle.PlayFiring only ever plays
// Fire1 — so it is written into the glTF and left out of `anims`. It exists; nothing plays
// it. That is Epic's, and inventing a rate for it is how the Redeemer once got an idle
// animation it never had.
//
// ---------------------------------------------------------------------------
// WHAT THE PAWN IS DOING MEANWHILE
// ---------------------------------------------------------------------------
// The gun does not carry the recoil — the BODY does. Botpack.TournamentPlayer.PlayRecoil
// plays StillSmFr on the pawn, PlayFiring swaps RunSm -> RunSmFr and WalkSm -> WalkSmFr,
// and build-ut-characters.mjs emits all three as the Fire / RunFire / WalkFire clips. A
// firing avatar is a pawn clip plus, on two of six weapons, a gun clip.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadPackage, classDefaults } from "./lib/upkg.mjs";
import { readMesh } from "./lib/umesh.mjs";
import { readTexture } from "./lib/utex.mjs";
import { writePng } from "./lib/png.mjs";
import { UU_TO_M } from "../src/shared/map-transform.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT_DIR = path.join(ROOT, "assets", "3d", "thirdperson");
const CHAR_DIR = path.join(ROOT, "assets", "3d", "characters");
const SYSTEM =
  process.argv[2] || path.join(os.homedir(), "Downloads", "Unreal Tournament", "System");

// UE1 PolyFlags, the ones that change how a surface draws. All six of these meshes come
// back with flags of 0 — one opaque, lit, single-sided material each — but the handling
// stays, because a mesh that grows a masked blade should not silently render as a black
// disc the way the Ripper's view mesh once did.
const PF_MASKED = 0x00000002;
const PF_TRANSLUCENT = 0x00000004;
const PF_TWOSIDED = 0x00000100;
const PF_UNLIT = 0x00400000;

// The pawn cylinder's half height. Every UT99 pawn, cow included, walks around in this
// one; it is what the weapons are lifted by, because a weapon has no wearer to ask.
const COLLISION_HEIGHT_UU = 39;
const PAWN_LIFT_M = COLLISION_HEIGHT_UU * UU_TO_M;

// Botpack holds the meshes and their textures; Engine holds the classes they inherit
// from, and ThirdPersonScale is an Engine.Inventory default that four of the six take
// unchanged. Reading only Botpack gives a scale of undefined.
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
const pkg = pkgs[0].pkg; // Botpack: every third-person mesh and every texture on one

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

/** A class's defaults WITH everything it inherits, most-derived last. */
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
  for (let i = chain.length - 1; i >= 0; i--) {
    Object.assign(out, classDefaults(chain[i].pkg, chain[i].exp));
  }
  return out;
}

// id -> the weapon CLASS in Botpack. The same six ids gen-weapons.mjs keys on, and the
// same two traps: the Enforcer's class is lowercase `enforcer` and the Ripper's is
// `ripper` (`Razor2` is its projectile AND its view mesh, and has no ThirdPersonMesh).
//
// There is no left/right pair here. enforcer.SetHand mirrors AutoML/AutoMR for the VIEW
// mesh only; ThirdPersonMesh is one AutoHand whichever hand you hold it in, so nothing
// here needs the `hand` field the view manifest carries.
const WEAPONS = [
  { id: "enforcer", cls: "enforcer" },
  { id: "sniper", cls: "SniperRifle" },
  { id: "shock", cls: "ShockRifle" },
  { id: "rocket", cls: "UT_Eightball" },
  { id: "ripper", cls: "ripper" },
  { id: "redeemer", cls: "WarheadLauncher" },
];

// The rest pose, and the two names that are not clips. 'All' is UE1's catch-all span over
// every frame in the mesh; 'Still' is the one-frame resting pose five of the six carry.
const REST_NAMES = ["Still", "All"];

// UnrealScript's rate MULTIPLIERS, by clip name, out of the view manifest — see WHICH
// ANIMATIONS in the header. One AnimSequence drives both meshes, so this is not a second
// source of truth, it is the same one read from the file that already holds it.
const VIEW = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts", "data", "ut-viewmodels.json"), "utf8"),
).weapons;

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
 * Kept in this row shape, exactly as build-ut-characters.mjs and build-ut-viewmodels.mjs
 * do, because the row form is what makes the transpose below obviously the right thing
 * rather than a lucky sign flip.
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

// UT axes (x forward, y right, z up) -> the world frame the client draws in (x right,
// y up, z BACK, so forward is -z). The characters' UT_TO_WORLD, character for character:
// the gun and the body have to land in the same frame or none of this means anything.
const UT_TO_WORLD = [
  [0, 1, 0],
  [0, 0, 1],
  [-1, 0, 0],
];

/**
 * The mesh-local -> world matrix for one third-person mesh, in metres per raw vertex unit.
 *
 * Mesh.Origin is NOT in here: it is subtracted from the raw vertex BEFORE this is applied,
 * because that is the order the character build measured on eight pawn meshes. It is not
 * inert here the way it is on a view mesh either — five of these six carry a large one
 * (AutoHand's is (0, 250, -60), RifleHand's (15, 170, -30)) and it is the whole reason the
 * gun ends up at the end of an arm instead of inside the pawn.
 */
function worldMatrix(mesh, thirdPersonScale) {
  const k = UU_TO_M * thirdPersonScale;
  const scale = [
    [mesh.scale[0] * k, 0, 0],
    [0, mesh.scale[1] * k, 0],
    [0, 0, mesh.scale[2] * k],
  ];
  const [pitch, yaw, roll] = mesh.rotOrigin.map(rotDeg);
  return matMul(UT_TO_WORLD, matMul(transpose(rotationMatrix(pitch, yaw, roll)), scale));
}

/**
 * The barrel tip, in world-frame metres. Derived exactly as the view models' is.
 *
 * Forward is -Z, so the frontmost geometry of a held weapon is its muzzle — the arm is
 * always behind the gun — and averaging the frontmost 6% of its length gives a ring of
 * muzzle vertices rather than one stray point. Computed on the REST pose, because on a
 * fire frame the whole gun has recoiled.
 */
function barrelTip(pos) {
  const zs = pos.map((p) => p[2]);
  const [minZ, maxZ] = [Math.min(...zs), Math.max(...zs)];
  const cutoff = minZ + (maxZ - minZ) * 0.06;
  const front = pos.filter((p) => p[2] <= cutoff);
  if (!front.length) throw new Error("no vertices at the front of the mesh");
  return [0, 1, 2].map((a) => front.reduce((t, p) => t + p[a], 0) / front.length);
}

/**
 * The signed volume the emitted triangles enclose, as glTF reads them.
 *
 * glTF front faces are counter-clockwise seen from outside, so a closed mesh wound that
 * way has POSITIVE signed volume about an interior point. These meshes are open at the
 * wrist, but the cut is a small flat disc against a whole gun and arm, so the sign is not
 * in doubt. CHECKED rather than reasoned about: a coordinate swap with determinant -1
 * reverses winding, and the check and the determinant have to agree or the build stops.
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
// BUILD
// ---------------------------------------------------------------------------

const manifest = {};
fs.mkdirSync(OUT_DIR, { recursive: true });
const rows = [];

for (const spec of WEAPONS) {
  const d = inheritedDefaults(spec.cls);
  const meshName = d.ThirdPersonMesh;
  if (!meshName) throw new Error(`${spec.id}: ${spec.cls} has no ThirdPersonMesh`);
  // Engine.Inventory's default is 1 and four of the six inherit it rather than set it.
  // Reading an unset property as 0 would collapse the mesh to a point.
  const thirdScale = d.ThirdPersonScale ?? 1;
  if (!(thirdScale > 0)) throw new Error(`${spec.id}: ThirdPersonScale is ${thirdScale}`);
  rows.push(buildModel(spec, meshName, thirdScale, d));
}

// --- where each body's gun hand is ------------------------------------------
// Read off the committed character glTFs rather than recomputed: extras.weaponAnchorM is
// the midpoint of that body's own weapon-attachment vertices, measured by the script that
// posed it, so a disagreement between the two pipelines shows up here as a number instead
// of as a gun at a hip.
const residuals = {};
for (const model of fs.readdirSync(CHAR_DIR).sort()) {
  const file = path.join(CHAR_DIR, model, `${model}.gltf`);
  if (!fs.existsSync(file)) continue;
  const extras = JSON.parse(fs.readFileSync(file, "utf8")).extras || {};
  const a = extras.weaponAnchorM;
  if (!Array.isArray(a) || a.length !== 3) {
    throw new Error(
      `${model}: no extras.weaponAnchorM — rerun node scripts/build-ut-characters.mjs first`,
    );
  }
  // The FULL anchor now, not the anchor minus a lift: the geometry above carries no lift
  // at all any more, so this is the whole placement rather than a correction to one.
  residuals[model] = a.map(r6);
}
if (!Object.keys(residuals).length) throw new Error(`no character models under ${CHAR_DIR}`);

const manifestPath = path.join(ROOT, "scripts", "data", "ut-thirdperson.json");
fs.writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      $comment: [
        "UT99 THIRD-PERSON weapons: the gun in the other player's hands.",
        "GENERATED by scripts/build-ut-thirdperson.mjs from a retail install — do not hand-edit.",
        "",
        "Inventory.ThirdPersonMesh at Inventory.ThirdPersonScale, through the SAME transform",
        "the characters use: (V - Mesh.Origin) x Mesh.Scale, x the TRANSPOSE of",
        "FRotationMatrix(RotOrigin), x UT (x fwd, y right, z up) -> world (x right, y up, z",
        "back). So forward is -Z and every barrel points -Z with nothing left to rotate.",
        "",
        "Geometry is lifted by the NOMINAL pawn half height (39 UU = 0.9165 m), because a",
        "weapon has no wearer to ask — which leaves it at the pawn's ACTOR ORIGIN, the middle",
        "of its chest and 42 cm below the Soldier's fist. pawnAnchor.offsetM is the vector",
        "that moves it into a given body's gun hand, from Epic's own weapon-attachment",
        "vertices; src/shared/characters.js carries the same numbers for the browser.",
        "",
        "anims.fire[].rate is UnrealScript's rate MULTIPLIER on the clip's own authored fps,",
        "which is already baked into the glTF keyframe times, and is taken from",
        "ut-viewmodels.json by clip name: a weapon actor has one AnimSequence and UE1 plays it",
        "on whichever mesh it is drawing. anims is null for the four meshes with one frame.",
        "",
        "muzzleLocal is the barrel tip in the model's own metres — the centroid of the",
        "frontmost 6% of its length, the same derivation the view models use.",
      ],
      pawnAnchor: {
        collisionHeightUU: COLLISION_HEIGHT_UU,
        node: "weaponAnchor",
        note:
          "THE STATIC FALLBACK. The real anchor is the node named weaponAnchor in each " +
          "character glTF, which every clip animates in translation AND rotation — the " +
          "pawn's weapon triangle is per-frame data and the hand travels 32-86 cm over a " +
          "run cycle. offsetM[model] is that node's BASE-POSE translation, for a client " +
          "that has no anchor node to parent to. Geometry here carries no lift: its origin " +
          "is the weapon's own origin and the anchor supplies the whole placement.",
        offsetM: residuals,
      },
      weapons: manifest,
    },
    null,
    1,
  ) + "\n",
);

console.log(
  `\n${"weapon".padEnd(9)} ${"mesh".padEnd(10)} ${"rest".padEnd(6)} ` +
    `wedges  mat  targets  clips   size (m)                 bbox centre (m)          bin`,
);
for (const r of rows) {
  console.log(
    `${r.id.padEnd(9)} ${r.mesh.padEnd(10)} ${r.baseSequence.padEnd(6)} ` +
      `${String(r.wedges).padStart(6)}  ${String(r.materials).padStart(3)}  ` +
      `${String(r.targets).padStart(7)}  ${String(r.clips.length).padStart(5)}   ` +
      `${r.size.map((v) => v.toFixed(3)).join(" x ").padEnd(23)}  ` +
      `${r.centre.map((v) => v.toFixed(3).padStart(6)).join(", ")}   ` +
      `${(r.binBytes / 1024).toFixed(0)}K`,
  );
}
console.log(
  `\ngeometry sits on its OWN origin — no lift; the weaponAnchor node in each body places ` +
    `it.\nStatic fallback (each body's base-pose anchor), in cm (x, y, z):\n` +
    Object.entries(residuals)
      .map(([m, v]) => `  ${m.padEnd(10)} ${v.map((x) => (x * 100).toFixed(1).padStart(6)).join(", ")}`)
      .join("\n") +
    `\nwrote ${path.relative(ROOT, manifestPath)}\nNow run: node scripts/gen-weapons.mjs`,
);

/**
 * One third-person mesh -> <id>.gltf + <id>.bin + its skin PNGs, in the world frame,
 * standing at the height a pawn holds it, with whatever clips UT99 plays on it.
 */
function buildModel(spec, meshName, thirdScale, defaults) {
  const mesh = readMesh(pkg, meshName);
  const M = worldMatrix(mesh, thirdScale);
  const O = mesh.origin;
  const dir = path.join(OUT_DIR, spec.id);
  fs.mkdirSync(dir, { recursive: true });

  // The resting pose. 'Still' where there is one, 'All' otherwise — RifleHand has a single
  // frame and only the catch-all name for it. Both resolve to the same frame on the five
  // meshes that carry both, which is checked below rather than assumed.
  const rest =
    mesh.anims.find((a) => a.name === "Still") || mesh.anims.find((a) => a.name === "All");
  if (!rest) {
    throw new Error(
      `${meshName}: no Still or All sequence to rest on — has ${mesh.anims.map((a) => a.name).join(", ")}`,
    );
  }
  const baseFrame = rest.startFrame;

  // Everything that is not the rest pose is a clip, named exactly as the package names it
  // (case included: glTF names are case-sensitive where UnrealScript's are not, which is
  // why the Enforcer's repeat clip is 'shot2' here and 'Shot2' in the script that plays it).
  const clipSeqs = mesh.anims.filter((a) => !REST_NAMES.includes(a.name));
  for (const s of clipSeqs) {
    if (!(s.rate > 0)) throw new Error(`${meshName}.${s.name}: rate is ${s.rate}`);
  }

  // Every frame any clip touches, minus the base frame — its delta is zero and an all-zero
  // weight vector already means "the rest pose".
  const wanted = new Set();
  for (const s of clipSeqs) for (let i = 0; i < s.numFrames; i++) wanted.add(s.startFrame + i);
  wanted.delete(baseFrame);
  const frames = [...wanted].sort((a, b) => a - b);
  const targetOf = new Map(frames.map((f, i) => [f, i]));

  // specialVerts is 0 on all six of these (they are not pawn meshes, so they carry no
  // weapon-anchor triangle), but the offset is written out rather than dropped so this
  // reads the same way as the two pipelines beside it.
  const framePos = (f) =>
    mesh.frame(f).map((v) => apply(M, [v[0] - O[0], v[1] - O[1], v[2] - O[2]]));
  const basePos = framePos(baseFrame);

  // Wedges are per-corner already (a vertex index plus a UV), so they map one to one onto
  // glTF vertices and nothing needs splitting.
  const positions = [];
  const uvs = [];
  for (const w of mesh.wedges) {
    const p = basePos[w.v + mesh.specialVerts];
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
  const texIndex = new Map();
  const pngFor = new Map();
  for (const [matIndex, wedgeIdx] of slots) {
    const mat = mesh.materials[matIndex];
    const texName = mesh.textures[mat.textureIndex];
    if (!texName) throw new Error(`${spec.id}: material ${matIndex} has no texture`);
    const flags = mat.polyFlags;
    if (!pngFor.has(texName)) {
      const file = `s${pngFor.size}.png`;
      // PF_Masked means palette index 0 is a hole, which is the only alpha UE1 has.
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
    if (flags & PF_TRANSLUCENT) material.alphaMode = "BLEND";
    else if (flags & PF_MASKED) material.alphaMode = "MASK";
    // Unlike a view model, a third-person weapon IS in the world and should take the
    // level's light. Only PF_Unlit forces it flat, and none of these six set it.
    if (flags & PF_UNLIT) material.extensions = { KHR_materials_unlit: {} };

    const indices = [];
    for (let i = 0; i < wedgeIdx.length; i += 3) {
      for (const o of order) indices.push(wedgeIdx[i + o]);
    }
    accessors.push({
      bufferView: push(Buffer.from(new Uint16Array(indices).buffer), 34963),
      componentType: 5123,
      count: indices.length,
      type: "SCALAR",
    });
    primitives.push({
      attributes: { POSITION, TEXCOORD_0: TEXCOORD },
      indices: accessors.length - 1,
      material: materials.length,
      // Every primitive carries the same target set: three.js and the glTF spec both
      // require the count to match across a mesh's primitives.
      ...(targets.length ? { targets } : {}),
    });
    materials.push(material);
  }

  // --- animations --------------------------------------------------------
  // Keyframe i sits at i/rate seconds where rate is the SEQUENCE's own authored fps; the
  // multiplier UnrealScript passes to PlayAnim rides in the manifest instead, so one clip
  // can serve two rates. LINEAR because UE1 tweens between frames.
  const animations = [];
  const clipInfo = [];
  for (const s of clipSeqs) {
    const keys = [];
    const weights = [];
    const one = (frame) => {
      const row = new Array(targets.length).fill(0);
      const t = targetOf.get(frame);
      if (t !== undefined) row[t] = 1;
      return row;
    };
    for (let i = 0; i < s.numFrames; i++) {
      keys.push(i / s.rate);
      weights.push(...one(s.startFrame + i));
    }
    if (s.numFrames === 1) {
      // A sampler with a single key has zero duration and some importers reject it.
      keys.push(1 / s.rate);
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
      name: s.name,
      samplers: [{ input, output, interpolation: "LINEAR" }],
      channels: [{ sampler: 0, target: { node: 0, path: "weights" } }],
    });
    clipInfo.push({
      clip: s.name,
      startFrame: s.startFrame,
      numFrames: s.numFrames,
      fps: r4(s.rate),
      seconds: r4(s.numFrames / s.rate),
    });
  }

  const bin = Buffer.concat(parts);
  fs.writeFileSync(path.join(dir, `${spec.id}.bin`), bin);

  const min = [0, 1, 2].map((a) => Math.min(...basePos.map((p) => p[a])));
  const max = [0, 1, 2].map((a) => Math.max(...basePos.map((p) => p[a])));
  const size = [0, 1, 2].map((a) => max[a] - min[a]);
  const centre = [0, 1, 2].map((a) => (min[a] + max[a]) / 2);
  // A held weapon points away from its owner, and forward is -Z, so it is longest along Z.
  // ENFORCED: a mesh that came out longest along X or Y is turned, and a turned gun in a
  // remote avatar's hand is the third-person version of the bug that had six of eight
  // bodies running backwards.
  if (size.indexOf(Math.max(...size)) !== 2) {
    throw new Error(
      `${spec.id}: longest along ${"XYZ"[size.indexOf(Math.max(...size))]}, not Z — ` +
        `the barrel is not pointing forward (size ${size.map((v) => v.toFixed(3)).join(" x ")})`,
    );
  }
  // ...and it sits ON its own origin, which is now the hand the anchor node will put it
  // in. Nothing here is lifted any more: a weapon whose box is half a metre from its own
  // origin has picked up a translation it should not have.
  if (!(Math.hypot(...centre) < 0.6)) {
    throw new Error(
      `${spec.id}: its box centre is ${centre.map((v) => v.toFixed(3)).join(", ")} m from ` +
        `its own origin — it is displaced, not just large`,
    );
  }

  const [pitch, yaw, roll] = mesh.rotOrigin.map(rotDeg);
  const gltf = {
    asset: { version: "2.0", generator: "build-ut-thirdperson.mjs" },
    ...(materials.some((m) => m.extensions?.KHR_materials_unlit)
      ? { extensionsUsed: ["KHR_materials_unlit"] }
      : {}),
    extras: {
      // Written from here so a future disagreement with a measurement taken off the
      // geometry is visible rather than silent — server/test/thirdperson.test.mjs measures
      // rather than reads.
      utMesh: meshName,
      utPackage: PACKAGES[0][1],
      utClass: spec.cls,
      thirdPersonScale: thirdScale,
      baseSequence: rest.name,
      baseFrame,
      worldFrame: "forward -Z, up +Y, right +X; lifted onto a 39 UU pawn; RotOrigin baked in",
      epicRotOriginDeg: [r4(pitch), r4(yaw), r4(roll)],
      meshOriginUU: mesh.origin.map(r4),
      orientationNote:
        "Vertices are mesh-frame, so they reach the actor frame through the TRANSPOSE of " +
        "UE1's FRotationMatrix(RotOrigin), with Mesh.Origin subtracted before Mesh.Scale — " +
        "the character pipeline's rule, unchanged, so the gun and the body land in one frame.",
      collisionHeightUU: COLLISION_HEIGHT_UU,
      placementNote:
        "NOT lifted. These vertices are the weapon's own actor-frame geometry about its own " +
        "origin, because UE1 draws a carried item at the owner pawn's weapon triangle with " +
        "that triangle's orientation: world = anchor.translation + anchor.rotation * vertex. " +
        "The anchor is the node named weaponAnchor in each character glTF, animated on every " +
        "clip; its base-pose translation is also in ut-thirdperson.json as a static fallback.",
      clips: clipInfo,
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: spec.id }],
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
    ...(animations.length ? { animations } : {}),
  };
  fs.writeFileSync(path.join(dir, `${spec.id}.gltf`), JSON.stringify(gltf, null, 1) + "\n");

  // --- the manifest row --------------------------------------------------
  // `anims` is null when the mesh has one frame — four of the six — rather than an empty
  // object, so a client can ask one question instead of two.
  const view = VIEW[spec.id];
  if (!view) throw new Error(`${spec.id}: no view model in ut-viewmodels.json`);
  const named = new Map(clipInfo.map((c) => [c.clip.toLowerCase(), c.clip]));
  /** The view plan's entry for a clip, matched by the PACKAGE's spelling of its name. */
  const shared = (entry) => {
    if (!entry) return null;
    const clip = named.get(entry.clip.toLowerCase());
    // Not an error: the Enforcer's view mesh has a 'Sway' idle that AutoHand has no
    // counterpart for, and a third-person mesh is allowed to be simpler than a view mesh.
    return clip ? { clip, rate: r6(entry.rate) } : null;
  };
  const fire = (view.anims?.fire || []).map(shared).filter(Boolean);
  const fireRepeat = shared(view.anims?.fireRepeat);
  const anims = fire.length
    ? {
        fire,
        ...(fireRepeat ? { fireRepeat } : {}),
        fireLoops: !!view.anims?.fireLoops,
      }
    : null;
  if (clipInfo.length && !anims) {
    throw new Error(
      `${spec.id}: ${meshName} has clips (${clipInfo.map((c) => c.clip).join(", ")}) but ` +
        `none of them is named in ut-viewmodels.json's fire plan — the two meshes' sequence ` +
        `names have stopped matching, so nothing would ever play them`,
    );
  }

  manifest[spec.id] = {
    model: `assets/3d/thirdperson/${spec.id}/${spec.id}.gltf`,
    mesh: meshName,
    thirdPersonScale: thirdScale,
    sizeM: size.map(r4),
    bboxM: { min: min.map(r4), max: max.map(r4) },
    centreM: centre.map(r4),
    muzzleLocal: barrelTip(basePos).map(r4),
    baseSequence: rest.name,
    baseFrame,
    anims,
    // Every sequence that made it into the glTF, whether or not anything plays it —
    // ASMD2hand's 'Fire2' is here and not in `anims`, and that is Epic's, not an omission.
    clipsInGltf: clipInfo,
  };

  return {
    id: spec.id,
    mesh: meshName,
    baseSequence: rest.name,
    wedges: mesh.wedges.length,
    materials: materials.length,
    targets: targets.length,
    clips: clipInfo,
    size,
    centre,
    binBytes: bin.length,
  };
}
