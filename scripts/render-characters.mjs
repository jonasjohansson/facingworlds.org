#!/usr/bin/env node
// render-characters.mjs — draw the COMMITTED character glTFs from the side, so a body
// that faces the wrong way is a picture rather than a number.
//
//   node scripts/render-characters.mjs [out.png] [--clip=Run@0.3] [--width=300]
//
// DEV TOOLING, and like scripts/render-viewmodels.mjs it needs NO retail install: it reads
// assets/3d/characters/**, which is committed. That is the whole point. Seven of the eight
// bodies ran BACKWARDS for months — every glTF was valid, every model stood at the right
// height, every clip played — and the only thing that would have caught it in five seconds
// is a picture of a running man.
//
// One column per model, two rows: Idle on top, Run below. The camera looks down +X, so:
//
//     THE RIG'S FORWARD (-Z) IS TO THE RIGHT. EVERY BODY MUST RUN TO THE RIGHT.
//
// Toes right, chest right, back of the head on the left. Anything facing left is the bug.
//
// Flat-shaded and untextured on purpose: this answers "which way is it pointing", which a
// silhouette answers perfectly, and staying untextured keeps the whole tool short enough
// to be worth having. scripts/render-viewmodels.mjs is the textured one.
//
// modelYaw() from the shared roster is applied, so this renders what the GAME draws rather
// than what the file contains — if a per-model yaw is ever reintroduced, this sees it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writePng } from "./lib/png.mjs";
import { BASE, MODELS, VARIANTS, modelYaw } from "../src/shared/characters.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const OUT = args.find((a) => !a.startsWith("--")) || path.join(ROOT, "characters.png");
const W = Number(opt("width", 300));
const H = Math.round(W * 1.2);
// Which clips to draw and how far through each, as name@fraction. Run defaults to 0.3
// rather than 0 because frame 0 of a run cycle is a passing pose with the legs together,
// which is the one frame in the stride that says least about which way the body is going.
const CLIPS = opt("clip", "Idle@0,Run@0.3")
  .split(",")
  .map((s) => {
    const [name, at] = s.split("@");
    return { name, at: Number(at || 0) };
  });

/** A very small glTF reader: enough for what build-ut-characters.mjs writes. */
function readGltf(file) {
  const g = JSON.parse(fs.readFileSync(file, "utf8"));
  const bin = fs.readFileSync(path.join(path.dirname(file), g.buffers[0].uri));
  const read = (i) => {
    const a = g.accessors[i];
    const v = g.bufferViews[a.bufferView];
    const b = bin.subarray(v.byteOffset + (a.byteOffset || 0));
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3 }[a.type];
    const out =
      a.componentType === 5123 ? new Uint16Array(a.count * n) : new Float32Array(a.count * n);
    for (let k = 0; k < a.count * n; k++) {
      out[k] = a.componentType === 5123 ? b.readUInt16LE(k * 2) : b.readFloatLE(k * 4);
    }
    return out;
  };
  return { g, read };
}

/**
 * Every triangle of one model, posed partway through one clip and turned by its modelYaw.
 *
 * The pose is the morph weights at the nearest keyframe rather than an interpolation
 * between two: the clips are one-hot, so a keyframe IS a UT99 frame, and any blend of two
 * of them is a pose UT99 never draws.
 */
function poseTriangles(id, clipName, at) {
  const file = path.join(ROOT, BASE, id, MODELS[id].gltf);
  const { g, read } = readGltf(file);
  const anim = g.animations.find((a) => a.name === clipName);
  if (!anim) throw new Error(`${id}: no clip "${clipName}"`);
  const sampler = anim.samplers[anim.channels[0].sampler];
  const times = read(sampler.input);
  const weights = read(sampler.output);
  const nTargets = weights.length / times.length;
  const key = Math.min(times.length - 1, Math.round(at * (times.length - 1)));

  const yaw = (modelYaw(VARIANTS.findIndex((v) => v[0] === id)) * Math.PI) / 180;
  const [cy, sy] = [Math.cos(yaw), Math.sin(yaw)];

  const tris = [];
  for (const prim of g.meshes[0].primitives) {
    const base = read(prim.attributes.POSITION);
    const p = new Float32Array(base); // a copy: primitives share one POSITION accessor
    for (let t = 0; t < nTargets; t++) {
      const w = weights[key * nTargets + t];
      if (!w) continue;
      const d = read(prim.targets[t].POSITION);
      for (let i = 0; i < p.length; i++) p[i] += w * d[i];
    }
    const pts = [];
    for (let i = 0; i < p.length; i += 3) {
      pts.push([p[i] * cy + p[i + 2] * sy, p[i + 1], -p[i] * sy + p[i + 2] * cy]);
    }
    const idx = read(prim.indices);
    for (let i = 0; i < idx.length; i += 3) tris.push([pts[idx[i]], pts[idx[i + 1]], pts[idx[i + 2]]]);
  }
  return tris;
}

/** One z-buffered, flat-shaded cell, viewed down +X with -Z to the right. */
function drawCell(tris) {
  const proj = (p) => [-p[2], -p[1], p[0]];
  const screen = tris.flat().map(proj);
  const [xs, ys] = [screen.map((q) => q[0]), screen.map((q) => q[1])];
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  const scale = 0.9 * Math.min(W / (maxX - minX || 1), H / (maxY - minY || 1));
  const [cx, cy] = [(minX + maxX) / 2, (minY + maxY) / 2];
  const toScreen = (q) => [(q[0] - cx) * scale + W / 2, (q[1] - cy) * scale + H / 2, q[2]];

  const img = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    img[i * 4] = img[i * 4 + 1] = img[i * 4 + 2] = 26;
    img[i * 4 + 3] = 255;
  }
  const depth = new Float32Array(W * H).fill(-Infinity);
  for (const [a, b, c] of tris) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n) || 1;
    const shade = Math.abs((n[0] * 0.7 + n[1] * 0.5 + n[2] * 0.3) / len);
    const col = [70 + 170 * shade, 70 + 150 * shade, 70 + 120 * shade];
    const [A, B, C] = [toScreen(proj(a)), toScreen(proj(b)), toScreen(proj(c))];
    const det = (B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]);
    if (Math.abs(det) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0])));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
    const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1])));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const l1 = ((B[0] - x) * (C[1] - y) - (C[0] - x) * (B[1] - y)) / det;
        const l2 = ((C[0] - x) * (A[1] - y) - (A[0] - x) * (C[1] - y)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
        const z = l1 * A[2] + l2 * B[2] + l3 * C[2];
        const k = y * W + x;
        if (z <= depth[k]) continue;
        depth[k] = z;
        img[k * 4] = col[0];
        img[k * 4 + 1] = col[1];
        img[k * 4 + 2] = col[2];
      }
    }
  }
  return img;
}

const ids = Object.keys(MODELS);
const sheet = Buffer.alloc(W * ids.length * H * CLIPS.length * 4);
ids.forEach((id, col) => {
  CLIPS.forEach((clip, row) => {
    const cell = drawCell(poseTriangles(id, clip.name, clip.at));
    for (let y = 0; y < H; y++) {
      cell.copy(sheet, ((row * H + y) * (W * ids.length) + col * W) * 4, y * W * 4, (y + 1) * W * 4);
    }
  });
});
fs.writeFileSync(OUT, writePng(W * ids.length, H * CLIPS.length, sheet));
console.log(
  `wrote ${path.relative(ROOT, OUT)}\n` +
    `  columns: ${ids.join(", ")}\n` +
    `  rows:    ${CLIPS.map((c) => `${c.name}@${c.at}`).join(", ")}\n` +
    `  viewed down +X, so the rig's FORWARD (-Z) is to the RIGHT: every body must face right.`,
);
