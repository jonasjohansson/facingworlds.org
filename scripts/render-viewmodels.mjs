#!/usr/bin/env node
// render-viewmodels.mjs — draw the COMMITTED view-model glTFs the way the game will.
//
//   node scripts/render-viewmodels.mjs [out.png] [--anim=Select@0.5] [--width=480]
//
// DEV TOOLING, and unlike build-ut-viewmodels.mjs it needs NO retail install: it reads
// assets/3d/viewmodels/**, which is committed. That is the whole point. The orientation
// bug it exists to catch — a weapon pointing at the player's face — is invisible in every
// number the extractor prints and obvious in one picture, and "look at it in the browser"
// is not a check anyone can run in five seconds a year from now.
//
// Three orthographic views per model, left to right:
//
//   FRONT      down the barrel from where the eye is (view forward is -Z). A correct
//              weapon is seen end-on: a muzzle, with the grip and arm below it.
//   FROM LEFT  the player's left. THE BARREL MUST POINT RIGHT. This is the view that
//              catches a gun turned round, and the one worth looking at first.
//   FROM ABOVE THE BARREL MUST POINT UP.
//
// The red cross is `muzzleLocal` from scripts/data/ut-viewmodels.json — the manifest's
// own answer, not a fresh guess — so a cross that is not at the barrel tip is a real
// disagreement between the manifest and the geometry.
//
// Textures are sampled from the model's own PNGs, because an untextured UT99 gun is a
// grey blob and half of what a person checks here ("is that the arm or the barrel?") is
// answered by the skin.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { writePng } from "./lib/png.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const MANIFEST = path.join(ROOT, "scripts", "data", "ut-viewmodels.json");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const OUT = args.find((a) => !a.startsWith("--")) || path.join(ROOT, "viewmodels.png");
const W = Number(opt("width", 480));
const H = Math.round(W * 0.75);
// --anim=Select@0.4 poses every model at 40% through its Select clip, so the animation
// data can be eyeballed too rather than only asserted about.
const ANIM = opt("anim", null);

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")).weapons;

// ---------------------------------------------------------------------------
// A very small glTF reader: enough for what this generator writes.
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

/** Every PNG the model references, decoded to RGBA. */
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
  // PNG filters, the five of them. Only Sub/Up/Average/Paeth ever appear here.
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
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rgba[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, rgba };
}

const VIEWS = [
  ["front", (p) => [p[0], -p[1], p[2]]],
  ["from the left", (p) => [-p[2], -p[1], -p[0]]],
  ["from above", (p) => [p[0], p[2], p[1]]],
];

/** One model's three panels, as an RGBA buffer W*3 wide and H tall. */
function renderModel(file, muzzle) {
  const { g, dir, read } = readGltf(file);
  const prim0 = g.meshes[0].primitives[0];
  const base = read(prim0.attributes.POSITION);
  const pos = Float32Array.from(base);

  // Optional pose: LINEAR through the clip's own keyframes, exactly as three.js would.
  if (ANIM) {
    const [name, atRaw] = ANIM.split("@");
    const at = Number(atRaw ?? 0.5);
    const anim = (g.animations || []).find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (anim) {
      const s = anim.samplers[anim.channels[0].sampler];
      const keys = read(s.input);
      const out = read(s.output);
      const n = out.length / keys.length;
      const t = keys[0] + at * (keys[keys.length - 1] - keys[0]);
      let i = 0;
      while (i < keys.length - 2 && keys[i + 1] < t) i++;
      const u = keys[i + 1] === keys[i] ? 0 : (t - keys[i]) / (keys[i + 1] - keys[i]);
      for (let k = 0; k < n; k++) {
        const w = out[i * n + k] * (1 - u) + out[(i + 1) * n + k] * u;
        if (!w) continue;
        const d = read(prim0.targets[k].POSITION);
        for (let v = 0; v < pos.length; v++) pos[v] += d[v] * w;
      }
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
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const sc = 0.85 * Math.min(W / (maxX - minX || 1), H / (maxY - minY || 1));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const toS = (p) => [(p[0] - cx) * sc + W / 2, (p[1] - cy) * sc + H / 2, p[2]];

    const zb = new Float32Array(W * H).fill(-Infinity);
    const img = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      img[i * 4] = img[i * 4 + 1] = img[i * 4 + 2] = 24;
      img[i * 4 + 3] = 255;
    }
    for (const { i: t, tex } of tris) {
      const w = t.map((k) => [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]]);
      const e1 = [w[1][0] - w[0][0], w[1][1] - w[0][1], w[1][2] - w[0][2]];
      const e2 = [w[2][0] - w[0][0], w[2][1] - w[0][1], w[2][2] - w[0][2]];
      const nr = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const ln = Math.hypot(...nr) || 1;
      // Deliberately two-sided lighting: these skins are near-black and a correctly wound
      // gun lit one-sided is unreadable. Winding is checked in the extractor, not here.
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
          img[k * 4] = Math.min(255, tex.rgba[s] * sh);
          img[k * 4 + 1] = Math.min(255, tex.rgba[s + 1] * sh);
          img[k * 4 + 2] = Math.min(255, tex.rgba[s + 2] * sh);
        }
      }
    }
    const m = toS(proj(muzzle));
    for (let d = -8; d <= 8; d++) {
      for (const [px, py] of [
        [m[0] + d, m[1]],
        [m[0], m[1] + d],
      ]) {
        const x = Math.round(px);
        const y = Math.round(py);
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const k = y * W + x;
        img[k * 4] = 255;
        img[k * 4 + 1] = 50;
        img[k * 4 + 2] = 50;
      }
    }
    for (let y = 0; y < H; y++) img.copy(panel, (y * W * 3 + vi * W) * 4, y * W * 4, (y + 1) * W * 4);
  });
  return panel;
}

const rows = [];
for (const [id, w] of Object.entries(manifest)) {
  // The Enforcer's right-hand mesh is the mirror of its left, so it has a muzzle of its
  // own — the same point with x negated. Using the left one's for both draws the cross a
  // barrel's width off the gun and makes a correct model look wrong.
  for (const [label, model, muzzle] of [
    [id, w.model, w.muzzleLocal],
    ...(w.dualModel ? [[`${id} (right)`, w.dualModel, w.dualMuzzleLocal || w.muzzleLocal]] : []),
  ]) {
    rows.push({ label, panel: renderModel(path.join(ROOT, model), muzzle) });
  }
}
const sheet = Buffer.alloc(W * 3 * H * rows.length * 4);
rows.forEach((r, i) => r.panel.copy(sheet, i * W * 3 * H * 4));
fs.writeFileSync(OUT, writePng(W * 3, H * rows.length, sheet));
console.log(
  `wrote ${OUT}\n` +
    `  columns: front (down the barrel) | from the left (barrel must point RIGHT) | from above (barrel must point UP)\n` +
    `  rows: ${rows.map((r) => r.label).join(", ")}` +
    (ANIM ? `\n  posed at ${ANIM}` : ""),
);
