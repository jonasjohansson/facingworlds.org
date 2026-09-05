#!/usr/bin/env node
// render-effects.mjs — draw the COMMITTED impact-effect glTFs, textured.
//
//   node scripts/render-effects.mjs [out.png] [--at=1] [--width=420]
//
// DEV TOOLING, and like render-viewmodels.mjs it needs NO retail install: it reads
// assets/3d/effects/**, which is committed. Same reason, too. The failure this exists to
// catch — an effect turned the wrong way, or built from the wrong frame, or scaled by its
// DrawScale twice — is invisible in every number the extractor prints and obvious in one
// picture, and "load it in the browser" is not a check anyone can run in five seconds a
// year from now.
//
// These are WORLD models, not view models, so the three panels are the world's axes rather
// than a shooter's:
//
//   ALONG +X    down the effect's own forward, which is the surface normal it was spawned
//               against. The ring is a RING here and nothing else is; the beam is seen
//               end-on as a small blob.
//   SIDE        forward to the right, up on the screen. The beam is a long streak, the
//               bullet impact a splash fanning out to the right, the shell a little
//               cylinder.
//   TOP         forward to the right, seen from above.
//
// THE RING'S SIDE AND TOP PANELS COME UP EMPTY, and that is the check rather than a bug:
// UTRingex is a flat annulus with exactly zero thickness, so edge-on it projects to a
// zero-height line and every triangle is degenerate. A ring with any depth at all would
// draw something there, and would mean the pitch-90 RotOrigin had not been applied.
//
// `--at=N` poses a morph-animated model at keyframe N, which is the only way to see that
// the ring's 'Explo' clip really expands: at 0 it is 0.37 m across and at 8 it is 4.71 m.
// The panels are scaled INDEPENDENTLY per model so a 4.7 m ring and a 5 cm shell can share
// a sheet; the metre figure under each row is what says how big the thing actually is.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { writePng } from "./lib/png.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const MANIFEST = path.join(ROOT, "scripts", "data", "ut-effects.json");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const OUT = args.find((a) => !a.startsWith("--")) || path.join(ROOT, "effects.png");
const W = Number(opt("width", 420));
const H = Math.round(W * 0.75);
const AT = opt("at", null) === null ? null : Number(opt("at", 0));

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")).models;

// ---------------------------------------------------------------------------
// A very small glTF reader: enough for what build-ut-effects.mjs writes.
// ---------------------------------------------------------------------------
function readGltf(file) {
  const g = JSON.parse(fs.readFileSync(file, "utf8"));
  const dir = path.dirname(file);
  const bin = fs.readFileSync(path.join(dir, g.buffers[0].uri));
  const view = (i) => {
    const v = g.bufferViews[i];
    return bin.subarray(v.byteOffset, v.byteOffset + v.byteLength);
  };
  const read = (i) => {
    const a = g.accessors[i];
    const b = view(a.bufferView);
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3 }[a.type];
    const out = a.componentType === 5123 ? new Uint16Array(a.count * n) : new Float32Array(a.count * n);
    for (let k = 0; k < a.count * n; k++) {
      out[k] = a.componentType === 5123 ? b.readUInt16LE(k * 2) : b.readFloatLE(k * 4);
    }
    return out;
  };
  return { g, dir, read };
}

/** One PNG, decoded to RGBA. Same five filters as render-viewmodels.mjs. */
function readPng(file) {
  const buf = fs.readFileSync(file);
  let p = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error(`${file}: only 8-bit RGBA is handled`);
    } else if (type === "IDAT") idat.push(data);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? rgba[y * stride + x - 4] : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const [pa, pb, pc] = [Math.abs(pp - a), Math.abs(pp - b), Math.abs(pp - c)];
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rgba[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, rgba };
}

// Model space is scene space: forward +X, up +Y, right +Z. Each entry maps a model point
// to (screen x, screen y up, depth).
const VIEWS = [
  ["along +X", (p) => [p[2], p[1], -p[0]]],
  ["side", (p) => [p[0], p[1], p[2]]],
  ["top", (p) => [p[0], p[2], p[1]]],
];

/** One model's three panels, as an RGBA buffer W*3 wide and H tall. */
function renderModel(file) {
  const { g, dir, read } = readGltf(file);
  const prim0 = g.meshes[0].primitives[0];
  const pos = Float32Array.from(read(prim0.attributes.POSITION));

  // Pose at one keyframe of the model's clip, if it has one and one was asked for. These
  // clips are one-hot weight vectors, so "keyframe N" is exactly "morph target N-1 at 1".
  if (AT !== null && g.animations?.length) {
    const anim = g.animations[0];
    const s = anim.samplers[anim.channels[0].sampler];
    const keys = read(s.input);
    const out = read(s.output);
    const n = out.length / keys.length;
    const i = Math.max(0, Math.min(keys.length - 1, AT));
    for (let k = 0; k < n; k++) {
      const w = out[i * n + k];
      if (!w) continue;
      const d = read(prim0.targets[k].POSITION);
      for (let v = 0; v < pos.length; v++) pos[v] += d[v] * w;
    }
  }

  const skins = g.images.map((im) => readPng(path.join(dir, im.uri)));
  const uv = read(prim0.attributes.TEXCOORD_0);
  const tris = [];
  for (const prim of g.meshes[0].primitives) {
    const idx = read(prim.indices);
    const tex = skins[g.textures[g.materials[prim.material].pbrMetallicRoughness.baseColorTexture.index].source];
    for (let i = 0; i < idx.length; i += 3) tris.push({ i: [idx[i], idx[i + 1], idx[i + 2]], tex });
  }

  const panel = Buffer.alloc(W * 3 * H * 4);
  VIEWS.forEach(([, proj], vi) => {
    const P = [];
    for (let i = 0; i < pos.length; i += 3) P.push(proj([pos[i], pos[i + 1], pos[i + 2]]));
    const xs = P.map((p) => p[0]);
    const ys = P.map((p) => p[1]);
    const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
    const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
    // A flat model (the ring, edge-on) has zero extent on one axis; falling back to the
    // other axis keeps its scale honest instead of blowing it up to fill the panel.
    const spanX = maxX - minX || maxY - minY || 1;
    const spanY = maxY - minY || maxX - minX || 1;
    const sc = 0.85 * Math.min(W / spanX, H / spanY);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const toS = (p) => [(p[0] - cx) * sc + W / 2, H / 2 - (p[1] - cy) * sc, p[2]];

    const zb = new Float32Array(W * H).fill(-Infinity);
    const img = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      img[i * 4] = img[i * 4 + 1] = img[i * 4 + 2] = 24;
      img[i * 4 + 3] = 255;
    }
    for (const { i: t, tex } of tris) {
      const w = t.map((k) => [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]]);
      const e1 = [0, 1, 2].map((a) => w[1][a] - w[0][a]);
      const e2 = [0, 1, 2].map((a) => w[2][a] - w[0][a]);
      const nr = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const ln = Math.hypot(...nr) || 1;
      // Two-sided lighting on purpose: these skins are near-black energy textures and a
      // one-sided shade makes half of every model unreadable. Winding is checked in the
      // extractor against the transform's determinant, not here.
      const sh = 1.6 + 2.4 * Math.abs((nr[0] * 0.3 + nr[1] * 0.85 + nr[2] * 0.45) / ln);
      const S = t.map((k) => toS(proj([pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]])));
      const [A, B, C] = S;
      const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0])));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
      const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1])));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
      const det = (B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]);
      if (Math.abs(det) < 1e-12) continue;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const l1 = ((B[0] - x) * (C[1] - y) - (C[0] - x) * (B[1] - y)) / det;
          const l2 = ((C[0] - x) * (A[1] - y) - (A[0] - x) * (C[1] - y)) / det;
          const l3 = 1 - l1 - l2;
          if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
          const z = l1 * A[2] + l2 * B[2] + l3 * C[2];
          const k = y * W + x;
          if (z <= zb[k]) continue;
          zb[k] = z;
          const tu = l1 * uv[t[0] * 2] + l2 * uv[t[1] * 2] + l3 * uv[t[2] * 2];
          const tv = l1 * uv[t[0] * 2 + 1] + l2 * uv[t[1] * 2 + 1] + l3 * uv[t[2] * 2 + 1];
          const px = ((Math.round(tu * tex.width) % tex.width) + tex.width) % tex.width;
          const py = ((Math.round(tv * tex.height) % tex.height) + tex.height) % tex.height;
          const s = (py * tex.width + px) * 4;
          for (let a = 0; a < 3; a++) img[k * 4 + a] = Math.min(255, tex.rgba[s + a] * sh);
        }
      }
    }
    for (let y = 0; y < H; y++) img.copy(panel, (y * W * 3 + vi * W) * 4, y * W * 4, (y + 1) * W * 4);
  });
  return panel;
}

const rows = [];
for (const [id, d] of Object.entries(manifest)) {
  rows.push({ id, size: d.extentM, panel: renderModel(path.join(ROOT, d.model)) });
}
const sheet = Buffer.alloc(W * 3 * H * rows.length * 4);
rows.forEach((r, i) => r.panel.copy(sheet, i * W * 3 * H * 4));
fs.writeFileSync(OUT, writePng(W * 3, H * rows.length, sheet));
console.log(
  `wrote ${OUT}\n` +
    `  columns: along +X (the surface normal) | side (forward RIGHT, up UP) | top\n` +
    rows.map((r) => `  ${r.id.padEnd(13)} ${r.size.map((n) => n.toFixed(3)).join(" x ")} m`).join("\n") +
    (AT !== null ? `\n  posed at keyframe ${AT}` : ""),
);
