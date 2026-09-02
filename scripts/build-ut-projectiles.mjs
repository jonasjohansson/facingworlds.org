#!/usr/bin/env node
// build-ut-projectiles.mjs — the three projectile meshes, out of UT99 and into glTF.
//
//   node scripts/build-ut-projectiles.mjs [path-to-UT-System]
//
// DEV TOOLING, like the character extractor: it needs a retail install, so it is not part
// of any build. It writes assets/3d/projectiles/<id>/, those are committed, and
// gen-weapons.mjs reads the directory the way gen-characters.mjs reads the roster.
//
// GEOMETRY comes from scripts/lib/umesh.mjs, which reads the package directly. Its face
// and wedge counts were checked against umodel's own .3d export for all three meshes.
//
// TEXTURES come from umodel, as TGA, converted here with sips. Decoding UE1's palettized
// P8 by hand is a solved problem with a well-known way to get it subtly wrong — the
// channel order — and umodel is the reference implementation. Geometry is worth reading
// ourselves because we need it in a specific shape; a texture is just a texture.
//
// SIZE is derived end to end, not chosen:
//
//     scene metres = rawVertex x Mesh.Scale x Actor.DrawScale x UU_TO_M
//
// which lands the rocket at 0.83 m, the ripper blade at 0.71 m across and the Redeemer's
// missile at 1.88 m. Nothing here is eyeballed; if the chain were wrong these would be
// absurd rather than merely arguable.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPackage, classDefaults } from "./lib/upkg.mjs";
import { readMesh } from "./lib/umesh.mjs";
import { UU_TO_M } from "../src/shared/map-transform.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT_DIR = path.join(ROOT, "assets", "3d", "projectiles");
const SYSTEM =
  process.argv[2] || path.join(os.homedir(), "Downloads", "Unreal Tournament", "System");
const UMODEL = process.env.UMODEL || "umodel";

// FORWARD is +Z for every projectile, because UT99 orients them with rotator(Velocity)
// and the game does the same. Which of the mesh's own axes becomes forward is not the
// same question for all three, so it is stated per projectile rather than guessed:
//
//   rocket, missile   the LONG axis — they fly nose-first
//   blade             the SHORT axis, which is the disc's normal. Razor2 rolls about its
//                     travel axis, and a disc only spins in its own plane if that axis is
//                     the normal. Picking "longest" here would send it edge-on and it
//                     would spin like a coin on a table.
const PROJECTILES = [
  { id: "rocket", mesh: "UTRocket", actor: "RocketMk2", frame: "Wing", axis: "long" },
  { id: "ripper", mesh: "RazorBlade", actor: "Razor2", frame: 0, axis: "short" },
  { id: "redeemer", mesh: "missile", actor: "WarShell", frame: 0, axis: "long" },
];

const pkg = loadPackage(fs.readFileSync(path.join(SYSTEM, "BotPack.u")));

function tgaToPng(textureName, dest) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "utx-"));
  execFileSync(UMODEL, ["-export", `-path=${SYSTEM}`, `-out=${tmp}`, "BotPack.u", textureName], {
    stdio: "ignore",
  });
  const tga = walk(tmp).find((f) => path.basename(f).toLowerCase() === `${textureName.toLowerCase()}.tga`);
  if (!tga) throw new Error(`${textureName}: umodel produced no TGA`);
  execFileSync("sips", ["-s", "format", "png", tga, "--out", dest], { stdio: "ignore" });
  fs.rmSync(tmp, { recursive: true, force: true });
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else out.push(f);
  }
  return out;
}

for (const spec of PROJECTILES) {
  const mesh = readMesh(pkg, spec.mesh);
  const actor = classDefaults(pkg, pkg.findClass(spec.actor));
  const drawScale = actor.DrawScale ?? 1;

  // Which frame. A named one resolves through the mesh's own animation table, so
  // "Wing" is the rocket's fins-out pose rather than frame 0's fins-in.
  let frameIndex = 0;
  if (typeof spec.frame === "string") {
    const seq = mesh.anims.find((a) => a.name === spec.frame);
    if (!seq) throw new Error(`${spec.mesh}: no animation named ${spec.frame}`);
    frameIndex = seq.startFrame;
  } else {
    frameIndex = spec.frame;
  }
  const raw = mesh.frame(frameIndex);

  // Mesh-local -> Unreal world, then Unreal -> scene axes (x, z, y), then to metres.
  const k = UU_TO_M * drawScale;
  const ue = raw.map((v) => [
    (v[0] * mesh.scale[0] + mesh.origin[0]) * k,
    (v[1] * mesh.scale[1] + mesh.origin[1]) * k,
    (v[2] * mesh.scale[2] + mesh.origin[2]) * k,
  ]);
  let pos = ue.map(([x, y, z]) => [x, z, y]);

  // Put the flight axis on +Z.
  const extent = [0, 1, 2].map((a) => {
    const vals = pos.map((p) => p[a]);
    return Math.max(...vals) - Math.min(...vals);
  });
  const pick = spec.axis === "long" ? extent.indexOf(Math.max(...extent)) : extent.indexOf(Math.min(...extent));
  const order = pick === 0 ? [2, 1, 0] : pick === 1 ? [0, 2, 1] : [0, 1, 2];
  pos = pos.map((p) => [p[order[0]], p[order[1]], p[order[2]]]);
  const after = [0, 1, 2].map((a) => {
    const vals = pos.map((p) => p[a]);
    return Math.max(...vals) - Math.min(...vals);
  });
  const wanted = spec.axis === "long" ? Math.max(...after) : Math.min(...after);
  if (Math.abs(after[2] - wanted) > 1e-6) {
    throw new Error(`${spec.id}: flight axis did not land on +Z (extent ${after})`);
  }

  // Wedges are already per-corner (a vertex index plus a UV), so they map one to one onto
  // glTF vertices and no splitting is needed. One shared position/UV buffer serves every
  // material; only the index list is per material.
  const positions = [];
  const uvs = [];
  for (const w of mesh.wedges) {
    const p = pos[w.v + mesh.specialVerts];
    if (!p) throw new Error(`${spec.id}: wedge points at vertex ${w.v} of ${pos.length}`);
    positions.push(...p);
    uvs.push(w.u / 256, w.vv / 256);
  }

  // ONE PRIMITIVE PER MATERIAL, because the materials are not decoration. RazorBlade is
  // 68 faces of blade plus a SINGLE face carrying its motion trail on a different
  // texture, and that one translucent quad is 1.36 m long — draw it as part of the blade
  // and the blade measures 1.36 m instead of its real 0.30 m. The rocket and the missile
  // each keep a two-sided masked group for their exhaust end.
  const groups = new Map();
  for (const f of mesh.faces) {
    if (!groups.has(f.material)) groups.set(f.material, []);
    groups.get(f.material).push(f.w[0], f.w[2], f.w[1]); // flipped for handedness
  }

  const dir = path.join(OUT_DIR, spec.id);
  fs.mkdirSync(dir, { recursive: true });

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

  const bodyOnly = [];
  for (const [matIndex, indices] of [...groups.entries()].sort((x, y) => x[0] - y[0])) {
    const mat = mesh.materials[matIndex];
    const texName = mesh.textures[mat.textureIndex];
    if (!texName) throw new Error(`${spec.id}: material ${matIndex} has no texture`);
    if (!pngFor.has(texName)) {
      const file = `s${pngFor.size}.png`;
      pngFor.set(texName, images.length);
      images.push({ uri: file });
      textures.push({ source: images.length - 1, sampler: 0 });
      tgaToPng(texName, path.join(dir, file));
    }

    // UE1 PolyFlags, and the three that change how a surface is drawn.
    const PF_MASKED = 0x00000002;
    const PF_TRANSLUCENT = 0x00000004;
    const PF_TWOSIDED = 0x00000100;
    const PF_UNLIT = 0x00400000;
    const flags = mat.polyFlags;
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
    // Unlit in UE1 means "ignore the light here", which is what an exhaust flare or a
    // motion trail wants. glTF says the same thing with KHR_materials_unlit.
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
    if (matIndex === 0) bodyOnly.push(...indices);
  }

  const bin = Buffer.concat(parts);
  fs.writeFileSync(path.join(dir, `${spec.id}.bin`), bin);

  const min = [0, 1, 2].map((a) => Math.min(...pos.map((p) => p[a])));
  const max = [0, 1, 2].map((a) => Math.max(...pos.map((p) => p[a])));
  // The size that means anything is the BODY's, not the whole mesh including its trail.
  const bodyPts = [...new Set(bodyOnly)].map((w) => pos[mesh.wedges[w].v + mesh.specialVerts]);
  const bmin = [0, 1, 2].map((a) => Math.min(...bodyPts.map((p) => p[a])));
  const bmax = [0, 1, 2].map((a) => Math.max(...bodyPts.map((p) => p[a])));

  const usedUnlit = materials.some((m) => m.extensions?.KHR_materials_unlit);
  const gltf = {
    asset: { version: "2.0", generator: "build-ut-projectiles.mjs" },
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
  // The index accessors were numbered before the two attribute accessors were prepended.
  for (const prim of gltf.meshes[0].primitives) prim.indices += 2;
  fs.writeFileSync(path.join(dir, `${spec.id}.gltf`), JSON.stringify(gltf, null, 1) + "\n");

  // Report the dimension that means something, measured on the BODY only: length along
  // flight for a nose-first projectile, diameter across the face for the disc, whose Z
  // extent is its thickness rather than its size.
  const size =
    spec.axis === "long"
      ? `${(bmax[2] - bmin[2]).toFixed(2)} m long`
      : `${Math.max(bmax[0] - bmin[0], bmax[1] - bmin[1]).toFixed(2)} m across, ` +
        `${(bmax[2] - bmin[2]).toFixed(3)} thick`;
  console.log(
    `${spec.id.padEnd(9)} ${String(mesh.faces.length).padStart(4)} faces in ${groups.size} ` +
      `material${groups.size === 1 ? " " : "s"}  ${size.padEnd(26)}` +
      `frame ${frameIndex}  ${[...pngFor.keys()].join(" + ")}`,
  );
}
