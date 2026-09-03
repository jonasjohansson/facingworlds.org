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

const r4 = (n) => Math.round(n * 10000) / 10000;
const manifest = {};

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

  // Mesh-local -> Unreal units (the mesh's own Scale and Origin), times PlayerViewScale,
  // then to metres, then Unreal axes (x fwd, y right, z up) -> scene axes (x, z, y).
  const k = UU_TO_M * viewScale;
  const pos = raw.map((v) => {
    const x = (v[0] * mesh.scale[0] + mesh.origin[0]) * k;
    const y = (v[1] * mesh.scale[1] + mesh.origin[1]) * k;
    const z = (v[2] * mesh.scale[2] + mesh.origin[2]) * k;
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
  const ro = mesh.rotOrigin;
  manifest[spec.id] = {
    model: `assets/3d/viewmodels/${spec.id}/${spec.id}.gltf`,
    mesh: meshName,
    viewScale,
    rotOriginDeg: [r4(rotDeg(ro[0])), r4(rotDeg(ro[1])), r4(rotDeg(ro[2]))],
    playerViewOffsetUU: (vec(defaults.PlayerViewOffset) || [0, 0, 0]).map(r4),
    fireOffsetUU: (vec(defaults.FireOffset) || [0, 0, 0]).map(r4),
    sizeM: [r4(max[0] - min[0]), r4(max[1] - min[1]), r4(max[2] - min[2])],
  };

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
