#!/usr/bin/env node
// build-ut-viewmodels.mjs — the six FIRST-PERSON weapon meshes, out of UT99 and into glTF.
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
// floor — at one hardcoded scale of 0.32 and one hardcoded rotation of 90 degrees,
// fitted to the Enforcer and then applied to all six. So it did not so much sit wrongly
// in the hand as fail to be a held weapon at all: no arm, and every weapon wrong in its
// own direction.
//
// UT99 ships a separate PlayerViewMesh per weapon and the arm holding it is PART of that
// mesh, so there is no hand to align a gun into. Each weapon also carries its own
// placement, and this is what those actually are:
//
//     id         PlayerViewMesh   scale   PlayerViewOffset      RotOrigin (pitch,yaw,roll)
//     enforcer   AutoML           1       (3.30, -2.00, -3.00)  (0, 90, 0)
//     sniper     Rifle2m          2       (5.00, -1.60, -1.70)  (0, 90, 0)
//     shock      ASMD2M           2       (4.40, -1.70, -1.60)  (0, 90, 0)
//     rocket     Eightm           2       (2.40, -1.00, -2.20)  (0, -90, 0)
//     ripper     Razor2           1.4     (3.00, -1.60, -2.40)  (0, 90, 0)
//     redeemer   WarHead          1       (1.80,  1.00, -1.89)  (22.5, 90, -87.2)
//
// Two of those are things one constant cannot express: the ROCKET LAUNCHER's RotOrigin
// is -90, not +90, so the old code had it turned the wrong way round; and the REDEEMER
// is rotated on all three axes. The mesh scales are non-uniform too (Rifle2m is
// 0.01, 0.004, 0.02), which is why each weapon was wrong differently rather than all
// wrong alike.
//
// ---------------------------------------------------------------------------
// WHAT IS DERIVED HERE AND WHAT IS NOT
// ---------------------------------------------------------------------------
// GEOMETRY, SCALE and ROTATION are Epic's, end to end. TEXTURES come from
// scripts/lib/utex.mjs, which reads UE1's palettized textures directly — umodel is not
// installed any more, and these skins are not shared with any mesh whose textures are
// already committed, so there was nothing to reuse. That reader reproduces umodel's own
// output byte for byte on JuRocket1; see its header.
//
// POSITION IS NOT DERIVED. PlayerViewOffset is in Unreal Units, and at pawn scale
// (0.0235 m/UU) the Enforcer's (3.30, -2.00, -3.00) is about 8 cm from the eye, against
// the 0.2/-0.3/-0.5 m the game has always used. UE1 draws the view weapon through its
// own projection rather than plain world space, so that offset does not convert
// directly. What IS trustworthy is the offsets RELATIVE to each other, so they are
// emitted raw and src/game/components/first-person-weapon.js maps them through a single
// clearly-marked constant fitted by eye. Six weapons that are consistent with each other
// and collectively adjustable beats six independent guesses.
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
const OUT_DIR = path.join(ROOT, "assets", "3d", "viewmodels");
const SYSTEM =
  process.argv[2] || path.join(os.homedir(), "Downloads", "Unreal Tournament", "System");

// id -> the weapon CLASS in Botpack. Two of these are traps and both cost time once:
// the Enforcer's class is lowercase `enforcer`, and the Ripper's is `ripper` — `Razor2`
// is its PROJECTILE (it extends Engine.Projectile), and is also, separately, the name of
// the Ripper's view MESH. Looking up `Razor2` as the weapon returns a projectile whose
// defaults have no PlayerViewMesh at all.
const WEAPONS = [
  { id: "enforcer", cls: "enforcer" },
  { id: "sniper", cls: "SniperRifle" },
  { id: "shock", cls: "ShockRifle" },
  { id: "rocket", cls: "UT_Eightball" },
  { id: "ripper", cls: "ripper" },
  { id: "redeemer", cls: "WarheadLauncher" },
];

// UE1 PolyFlags, the ones that change how a surface draws.
const PF_MASKED = 0x00000002;
const PF_TRANSLUCENT = 0x00000004;
const PF_TWOSIDED = 0x00000100;
const PF_UNLIT = 0x00400000;

const pkgPath = path.join(SYSTEM, "Botpack.u");
if (!fs.existsSync(pkgPath)) {
  console.error(`no such file: ${pkgPath}`);
  console.error(`this tool needs a retail UT99 install; pass the System directory as an argument.`);
  process.exit(1);
}
const pkg = loadPackage(fs.readFileSync(pkgPath));

/** A UE1 rotator component (65536 to the turn) as degrees. */
const rotDeg = (units) => (units * 360) / 65536;

/** An FVector property, which readProperties hands back as raw struct bytes. */
function vec(v) {
  if (!v || !v.bytes) return null;
  const b = Buffer.from(v.bytes.data || v.bytes);
  return b.length >= 12 ? [b.readFloatLE(0), b.readFloatLE(4), b.readFloatLE(8)] : null;
}

/**
 * Rotate a point by an XYZ Euler in degrees, exactly as three.js does.
 *
 * This has to match A-Frame's `rotation` component or the muzzle lands somewhere the
 * barrel is not: A-Frame writes rotation straight into object3D.rotation, whose default
 * Euler order is XYZ, and the composed matrix below is three.js's own for that order.
 * Nothing here is free to be "equivalent but different".
 */
function rotateXYZ([x, y, z], degrees) {
  const [a, b, c] = degrees.map((d) => (d * Math.PI) / 180);
  const c1 = Math.cos(a), s1 = Math.sin(a);
  const c2 = Math.cos(b), s2 = Math.sin(b);
  const c3 = Math.cos(c), s3 = Math.sin(c);
  return [
    c2 * c3 * x - c2 * s3 * y + s2 * z,
    (c1 * s3 + s1 * s2 * c3) * x + (c1 * c3 - s1 * s2 * s3) * y - s1 * c2 * z,
    (s1 * s3 - c1 * s2 * c3) * x + (s1 * c3 + c1 * s2 * s3) * y + c1 * c2 * z,
  ];
}

/**
 * The barrel tip, in the mesh's own unrotated coordinates.
 *
 * Derived, not measured by hand: rotate the mesh the way the game will, take the
 * vertices at the FRONT of it (scene forward is -Z), and average them. The frontmost
 * geometry of a held weapon is its muzzle — the arm is always behind the gun — so this
 * needs no per-weapon knowledge and cannot drift when a mesh or a rotation changes.
 *
 * Returned unrotated because #weapon-muzzle is a CHILD of the weapon entity and inherits
 * its rotation and scale; handing back the rotated point would apply the rotation twice.
 */
function barrelTip(pos, rotationDeg) {
  const rotated = pos.map((p) => rotateXYZ(p, rotationDeg));
  let minZ = Infinity, maxZ = -Infinity;
  for (const p of rotated) {
    if (p[2] < minZ) minZ = p[2];
    if (p[2] > maxZ) maxZ = p[2];
  }
  // The frontmost 6% of the weapon's length. Wide enough to average a ring of muzzle
  // vertices rather than latch onto one stray point, narrow enough not to creep back
  // down the barrel.
  const cutoff = minZ + (maxZ - minZ) * 0.06;
  let n = 0;
  const sum = [0, 0, 0];
  for (let i = 0; i < pos.length; i++) {
    if (rotated[i][2] > cutoff) continue;
    sum[0] += pos[i][0];
    sum[1] += pos[i][1];
    sum[2] += pos[i][2];
    n++;
  }
  if (!n) throw new Error("no vertices at the front of the mesh");
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}

const r4 = (n) => Math.round(n * 10000) / 10000;
const manifest = {};
const facingAnomalies = [];

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const spec of WEAPONS) {
  const defaults = classDefaults(pkg, pkg.findClass(spec.cls)) || {};
  const meshName = defaults.PlayerViewMesh;
  if (!meshName) throw new Error(`${spec.id}: ${spec.cls} has no PlayerViewMesh`);
  // PlayerViewScale is inherited by the Enforcer and the Redeemer rather than set, and
  // Engine.Weapon's default is 1. Reading it as 0 would collapse the mesh to a point.
  const viewScale = defaults.PlayerViewScale ?? 1;
  if (!(viewScale > 0)) throw new Error(`${spec.id}: PlayerViewScale is ${viewScale}`);

  const mesh = readMesh(pkg, meshName);
  const raw = mesh.frame(0);

  // Mesh-local -> Unreal units (the mesh's own Scale), times PlayerViewScale, then to
  // metres, then Unreal axes (x fwd, y right, z up) -> scene axes (x, z, y).
  //
  // Mesh.Origin is deliberately NOT applied. It places a mesh relative to the ACTOR
  // carrying it, which is not the question a first-person view mesh answers, and five of
  // these six have an Origin of exactly zero — so it is inert for everything except
  // WarHead, whose (0, -210, -50) throws the Redeemer about 5 metres from the camera.
  // Where the weapon sits is handled by the offsets in first-person-weapon.js instead.
  const k = UU_TO_M * viewScale;
  const pos = raw.map((v) => {
    const x = v[0] * mesh.scale[0] * k;
    const y = v[1] * mesh.scale[1] * k;
    const z = v[2] * mesh.scale[2] * k;
    return [x, z, y];
  });

  const dir = path.join(OUT_DIR, spec.id);
  fs.mkdirSync(dir, { recursive: true });

  // Wedges are per-corner already (a vertex index plus a UV), so they map one to one
  // onto glTF vertices and nothing needs splitting.
  const positions = [];
  const uvs = [];
  for (const w of mesh.wedges) {
    const p = pos[w.v + mesh.specialVerts];
    if (!p) throw new Error(`${spec.id}: wedge points at vertex ${w.v} of ${pos.length}`);
    positions.push(...p);
    uvs.push(w.u / 256, w.vv / 256);
  }

  // One primitive per material: a view mesh is the arm and the gun on different skins,
  // and some carry a masked or translucent group for a sight or a muzzle end.
  const groups = new Map();
  for (const f of mesh.faces) {
    if (!groups.has(f.material)) groups.set(f.material, []);
    groups.get(f.material).push(f.w[0], f.w[2], f.w[1]); // flipped for handedness
  }

  const posBuf = Buffer.from(new Float32Array(positions).buffer);
  const uvBuf = Buffer.from(new Float32Array(uvs).buffer);
  const pad = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
  const parts = [pad(posBuf), pad(uvBuf)];
  const accessors = [];
  const bufferViews = [];
  const primitives = [];
  const materials = [];
  const images = [];
  const textures = [];
  const pngFor = new Map();

  let offset = 0;
  bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 });
  offset += pad(posBuf).length;
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: uvBuf.length, target: 34962 });
  offset += pad(uvBuf).length;

  for (const [matIndex, indices] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const mat = mesh.materials[matIndex];
    const texName = mesh.textures[mat.textureIndex];
    if (!texName) throw new Error(`${spec.id}: material ${matIndex} has no texture`);
    const flags = mat.polyFlags;
    if (!pngFor.has(texName)) {
      const file = `s${pngFor.size}.png`;
      pngFor.set(texName, images.length);
      images.push({ uri: file });
      textures.push({ source: images.length - 1, sampler: 0 });
      // PF_Masked means palette index 0 is a hole, which is the only alpha UE1 has.
      const img = readTexture(pkg, texName, { masked: (flags & PF_MASKED) !== 0 });
      // writePng wants a Buffer (it uses .copy); utex hands back a Uint8Array.
      const rgba = Buffer.from(img.rgba.buffer, img.rgba.byteOffset, img.rgba.length);
      fs.writeFileSync(path.join(dir, file), writePng(img.width, img.height, rgba));
    }

    const material = {
      name: `slot${materials.length}`,
      doubleSided: (flags & PF_TWOSIDED) !== 0,
      pbrMetallicRoughness: {
        baseColorTexture: { index: pngFor.get(texName) },
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

    const idxBuf = Buffer.from(new Uint16Array(indices).buffer);
    parts.push(pad(idxBuf));
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: idxBuf.length, target: 34963 });
    offset += pad(idxBuf).length;
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: 5123,
      count: indices.length,
      type: "SCALAR",
    });
    primitives.push({
      attributes: { POSITION: 0, TEXCOORD_0: 1 },
      indices: accessors.length - 1,
      material: materials.length,
    });
    materials.push(material);
  }

  const bin = Buffer.concat(parts);
  fs.writeFileSync(path.join(dir, `${spec.id}.bin`), bin);

  const min = [0, 1, 2].map((a) => Math.min(...pos.map((p) => p[a])));
  const max = [0, 1, 2].map((a) => Math.max(...pos.map((p) => p[a])));
  const usedUnlit = materials.some((m) => m.extensions?.KHR_materials_unlit);
  const gltf = {
    asset: { version: "2.0", generator: "build-ut-viewmodels.mjs" },
    ...(usedUnlit ? { extensionsUsed: ["KHR_materials_unlit"] } : {}),
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: spec.id }],
    meshes: [{ name: spec.id, primitives }],
    materials,
    textures,
    images,
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count: uvs.length / 2, type: "VEC2" },
      ...accessors,
    ],
    bufferViews,
    buffers: [{ uri: `${spec.id}.bin`, byteLength: bin.length }],
  };
  for (const prim of gltf.meshes[0].primitives) prim.indices += 2;
  fs.writeFileSync(path.join(dir, `${spec.id}.gltf`), JSON.stringify(gltf, null, 1) + "\n");

  // UE1 rotator: (Pitch, Yaw, Roll) about (Y, Z, X) in UT's axes. Emitted in degrees
  // rather than baked into the vertices so that the one thing still being fitted by eye
  // — see the header — stays visible and adjustable instead of frozen into geometry.
  // UE1 stores an FRotator as (Pitch, Yaw, Roll), and those turn about UT's OWN axes:
  // Pitch about Y (right), Yaw about Z (up), Roll about X (forward). The (x, z, y) swap
  // above sends UT's Y to scene Z and UT's Z to scene Y, so the components do not stay
  // in place on the way across:
  //
  //     UT Roll  (about UT X, forward)  ->  scene X
  //     UT Yaw   (about UT Z, up)       ->  scene Y
  //     UT Pitch (about UT Y, right)    ->  scene Z
  //
  // Emitting them in Epic's own order would be right only for the four weapons whose
  // pitch and roll are zero, and silently wrong for the Redeemer, which is the one
  // weapon that turns on all three.
  const ro = mesh.rotOrigin;
  const rotationDeg = [r4(rotDeg(ro[2])), r4(rotDeg(ro[1])), r4(rotDeg(ro[0]))];
  const muzzle = barrelTip(pos, rotationDeg);
  manifest[spec.id] = {
    model: `assets/3d/viewmodels/${spec.id}/${spec.id}.gltf`,
    mesh: meshName,
    viewScale,
    rotOriginDeg: rotationDeg,
    // The barrel tip in the mesh's own units, for #weapon-muzzle. Every weapon used to
    // borrow the Enforcer's, so a Redeemer's flash and tracer came off a point over a
    // metre from its actual muzzle.
    muzzleLocal: muzzle.map(r4),
    playerViewOffsetUU: (vec(defaults.PlayerViewOffset) || [0, 0, 0]).map(r4),
    fireOffsetUU: (vec(defaults.FireOffset) || [0, 0, 0]).map(r4),
    sizeM: [r4(max[0] - min[0]), r4(max[1] - min[1]), r4(max[2] - min[2])],
    // The mesh's actual box, not just its extents. server/test/viewmodels.test.mjs uses
    // it to assert the muzzle lies INSIDE the weapon — the check that catches a mesh
    // being displaced wholesale, which is exactly what applying WarHead's Origin did
    // (it put the Redeemer's barrel tip about 5 m from a mesh 5 cm deep).
    bboxM: { min: min.map(r4), max: max.map(r4) },
  };

  // A held weapon should be longest along Z, because scene forward is -Z and a gun
  // points away from the eye. This is not enforced — it is REPORTED — because Epic's own
  // rotation is better evidence than this heuristic and two of the six disagree with it;
  // see the note printed at the end.
  const rotatedExtent = (() => {
    const r = pos.map((p) => rotateXYZ(p, rotationDeg));
    return [0, 1, 2].map((a) => Math.max(...r.map((p) => p[a])) - Math.min(...r.map((p) => p[a])));
  })();
  const longest = "XYZ"[rotatedExtent.indexOf(Math.max(...rotatedExtent))];
  if (longest !== "Z") facingAnomalies.push(`${spec.id} (longest along ${longest})`);

  console.log(
    `${spec.id.padEnd(9)} ${meshName.padEnd(9)} ${String(mesh.wedges.length).padStart(4)} wedges, ` +
      `${materials.length} material${materials.length === 1 ? "" : "s"}, ${pngFor.size} texture${pngFor.size === 1 ? "" : "s"}` +
      `   ${manifest[spec.id].sizeM.map((n) => n.toFixed(2)).join(" x ")} m`,
  );
}

const manifestPath = path.join(ROOT, "scripts", "data", "ut-viewmodels.json");
fs.writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      $comment: [
        "UT99 first-person weapon placement, read out of each weapon class's defaults.",
        "GENERATED by scripts/build-ut-viewmodels.mjs from a retail install — do not hand-edit.",
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
if (facingAnomalies.length) {
  console.log(
    `\nNOTE: ${facingAnomalies.length} of ${WEAPONS.length} do not end up longest along Z:\n` +
      facingAnomalies.map((a) => `  ${a}`).join("\n") +
      `\n  Epic's RotOrigin is kept anyway — it is better evidence than "the long axis is\n` +
      `  the barrel", which is only a heuristic and is wrong for a pistol whose arm is the\n` +
      `  long part. Confirm these two in the browser rather than by argument.`,
  );
}
