#!/usr/bin/env node
// render-thirdperson.mjs — draw a body HOLDING each third-person weapon, so a gun that
// lands at the wrist, in the chest, or pointing backwards is a picture rather than a number.
//
//   node scripts/render-thirdperson.mjs [out.png] [--model=soldier] [--width=280]
//
// DEV TOOLING, and like scripts/render-characters.mjs it needs NO retail install: it reads
// assets/3d/characters/** and assets/3d/thirdperson/**, both committed. That is the point.
// The character pipeline learned this lesson the expensive way — six of the eight bodies
// ran backwards for months while every glTF stayed valid — and a weapon hung on a pawn has
// exactly the same failure mode: nothing throws, the numbers all look like numbers.
//
// Two rows, one column per weapon:
//
//   SIDE, looking down +X. The rig's forward (-Z) is to the RIGHT, so every barrel must
//   point RIGHT and the body must face right with it.
//   FRONT, looking down +Z from in front of the pawn. The gun must be in the silhouette's
//   hands, at chest-to-waist height, roughly on the body's centre line.
//
// The BODY is grey and the WEAPON is orange, because "is it in the hand" is a question
// about two objects and a single flat shade answers it badly. Both are drawn into one
// shared bounding box per cell, so the sizes are honest against each other.
//
// The body is posed on its IDLE frame — the armed stance, gun up — because that is the
// pose the weapon's rest frame was authored against. The weapon is drawn on its own rest
// pose with all morph weights at zero.
//
// The weapon is drawn where it is BUILT — lifted onto the nominal 39 UU pawn, which leaves
// it at the pawn's actor origin — plus that body's own weapon offset from
// scripts/data/ut-thirdperson.json, which is what a client parenting a gun to this body
// does. So this renders the intended result, not the raw file. Pass --raw to see the file
// without it, which is the picture that showed the gun sitting at the hip.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writePng } from "./lib/png.mjs";
import { BASE, MODELS } from "../src/shared/characters.js";

// The empty node scripts/build-ut-characters.mjs writes into every body. A client looks it
// up by name, so this does too.
const ANCHOR_NAME = "weaponAnchor";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const OUT = args.find((a) => !a.startsWith("--")) || path.join(ROOT, "thirdperson.png");
const MODEL = opt("model", "soldier");
const RAW = args.includes("--raw");
const W = Number(opt("width", 280));
const H = Math.round(W * 1.25);

const TP = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts", "data", "ut-thirdperson.json"), "utf8"),
);
// Which clip and how far through it, as name@fraction, one per row. The default is the
// question this tool exists for: does the gun stay in the hand through a stride?
const POSES = opt("poses", "Idle@0")
  .split(",")
  .map((t) => {
    const [name, at] = t.split("@");
    return { name, at: Number(at || 0) };
  });

/** A very small glTF reader: enough for what the two build scripts write. */
function readGltf(file) {
  const g = JSON.parse(fs.readFileSync(file, "utf8"));
  const bin = fs.readFileSync(path.join(path.dirname(file), g.buffers[0].uri));
  const read = (i) => {
    const a = g.accessors[i];
    const v = g.bufferViews[a.bufferView];
    const b = bin.subarray(v.byteOffset + (a.byteOffset || 0));
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
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
 * Every triangle of one glTF in its base pose, optionally shifted up by `lift`.
 *
 * Base pose, not a keyframe: both pipelines put the resting frame in POSITION with all
 * morph weights at zero, so this is what the file claims without any clip interpretation
 * in the way.
 */
/** Rotate a vector by a glTF quaternion [x, y, z, w]. */
function rotate(q, v) {
  const [x, y, z, w] = q;
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [
    v[0] + w * t[0] + (y * t[2] - z * t[1]),
    v[1] + w * t[1] + (z * t[0] - x * t[2]),
    v[2] + w * t[2] + (x * t[1] - y * t[0]),
  ];
}

/**
 * Every triangle of one glTF, posed partway through a clip and placed by a rigid transform.
 *
 * The pose is the morph weights at the NEAREST keyframe rather than a blend of two: the
 * clips are one-hot, so a keyframe IS a UT99 frame and any interpolation between two of
 * them is a pose UT99 never draws. `place` is { pos, quat }, which for a weapon is exactly
 * what the body's anchor node says — world = pos + quat * vertex, UE1's own composition.
 */
function triangles(file, { clip, at = 0, place } = {}) {
  const { g, read } = readGltf(file);
  const anim = clip ? (g.animations || []).find((a) => a.name === clip) : null;
  let weights = null;
  let key = 0;
  let nTargets = 0;
  if (anim) {
    const wch = anim.channels.find((c) => c.target.path === "weights");
    const sampler = anim.samplers[wch.sampler];
    const times = read(sampler.input);
    weights = read(sampler.output);
    nTargets = weights.length / times.length;
    key = Math.min(times.length - 1, Math.round(at * (times.length - 1)));
  }
  const put = (p) => {
    const q = place ? rotate(place.quat, p) : p;
    return place ? [q[0] + place.pos[0], q[1] + place.pos[1], q[2] + place.pos[2]] : q;
  };
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
    for (let i = 0; i < p.length; i += 3) pts.push(put([p[i], p[i + 1], p[i + 2]]));
    const idx = read(prim.indices);
    for (let i = 0; i < idx.length; i += 3) {
      tris.push([pts[idx[i]], pts[idx[i + 1]], pts[idx[i + 2]]]);
    }
  }
  return tris;
}

/**
 * The body's weaponAnchor node at one instant: where the hand is and how it is holding.
 *
 * Read the way a client reads it — find the node BY NAME, take the translation and rotation
 * channels that target it, and sample them at the same key the pose above uses. Nothing is
 * recomputed from the special vertices here, so this renders the file rather than the
 * extractor's intent, which is the only reason a picture of it is worth anything.
 */
function anchorOf(file, clip, at) {
  const { g, read } = readGltf(file);
  const node = (g.nodes || []).findIndex((n) => n.name === ANCHOR_NAME);
  if (node < 0) throw new Error(`${path.basename(file)}: no "${ANCHOR_NAME}" node`);
  const anim = (g.animations || []).find((a) => a.name === clip);
  if (!anim) throw new Error(`${path.basename(file)}: no clip "${clip}"`);
  const sample = (path_) => {
    const ch = anim.channels.find((c) => c.target.node === node && c.target.path === path_);
    if (!ch) throw new Error(`${clip}: the anchor has no ${path_} channel`);
    const s = anim.samplers[ch.sampler];
    const times = read(s.input);
    const out = read(s.output);
    const n = out.length / times.length;
    const k = Math.min(times.length - 1, Math.round(at * (times.length - 1)));
    return Array.from({ length: n }, (_, i) => out[k * n + i]);
  };
  return { pos: sample("translation"), quat: sample("rotation") };
}

// The two cameras. Each returns [screenX, screenY, depth] with bigger depth nearer.
//
//   side  looks down +X: -Z (the rig's forward) is to the right.
//   front looks down +Z from in front of the pawn, so the body's right (+X) appears on the
//         LEFT of the picture, the way a person facing you does.
const ALL_VIEWS = [
  { name: "side", proj: (p) => [-p[2], -p[1], p[0]] },
  { name: "front", proj: (p) => [-p[0], -p[1], -p[2]] },
];
// --views=side to get one big row instead of two small ones, which is the difference
// between "the gun is about there" and being able to see the fingers.
const VIEWS = opt("views", "side,front")
  .split(",")
  .map((n) => {
    const v = ALL_VIEWS.find((x) => x.name === n);
    if (!v) throw new Error(`no such view: ${n} — have ${ALL_VIEWS.map((x) => x.name).join(", ")}`);
    return v;
  });

/**
 * One z-buffered cell: a list of { tris, tint } drawn into one shared frame.
 *
 * The framing is computed over EVERYTHING in the cell, so a weapon that flew off to the
 * side shrinks the body rather than being quietly cropped out of the picture.
 */
function drawCell(layers, proj) {
  const all = layers.flatMap((l) => l.tris).flat().map(proj);
  const [xs, ys] = [all.map((q) => q[0]), all.map((q) => q[1])];
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
  for (const { tris, tint } of layers) {
    for (const [a, b, c] of tris) {
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const len = Math.hypot(...n) || 1;
      const shade = 0.25 + 0.75 * Math.abs((n[0] * 0.7 + n[1] * 0.5 + n[2] * 0.3) / len);
      const col = tint.map((t) => Math.min(255, t * shade));
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
  }
  return img;
}

const bodyFile = path.join(ROOT, BASE, MODEL, MODELS[MODEL].gltf);
if (!fs.existsSync(bodyFile)) throw new Error(`no such body: ${path.relative(ROOT, bodyFile)}`);

// One row per pose per view, outer pose; one column per weapon.
const ids = Object.keys(TP.weapons);
const rows = POSES.flatMap((pose) => VIEWS.map((view) => ({ pose, view })));
const sheet = Buffer.alloc(W * ids.length * H * rows.length * 4);
const report = [];

rows.forEach(({ pose, view }, row) => {
  const body = triangles(bodyFile, { clip: pose.name, at: pose.at });
  // --raw drops the anchor and draws the file where it sits, which is on its own origin at
  // the pawn's feet: the picture that shows what the anchor is actually doing.
  const place = RAW ? null : anchorOf(bodyFile, pose.name, pose.at);
  if (place) {
    report.push(
      `  ${(`${pose.name}@${pose.at}`).padEnd(12)} anchor ` +
        `${place.pos.map((v) => v.toFixed(3).padStart(6)).join(", ")}  quat ` +
        `${place.quat.map((v) => v.toFixed(3).padStart(6)).join(", ")}`,
    );
  }
  ids.forEach((id, col) => {
    const gun = triangles(path.join(ROOT, TP.weapons[id].model), { place });
    const cell = drawCell(
      [
        { tris: body, tint: [150, 150, 160] },
        { tris: gun, tint: [255, 150, 40] },
      ],
      view.proj,
    );
    for (let y = 0; y < H; y++) {
      cell.copy(sheet, ((row * H + y) * (W * ids.length) + col * W) * 4, y * W * 4, (y + 1) * W * 4);
    }
  });
});
fs.writeFileSync(OUT, writePng(W * ids.length, H * rows.length, sheet));
console.log(
  `wrote ${path.relative(ROOT, OUT)}\n` +
    `  body:    ${MODEL} (grey)${RAW ? ", weapons on their own origin (no anchor)" : `, weapons parented to its "${ANCHOR_NAME}" node`}\n` +
    `  columns: ${ids.join(", ")} (orange)\n` +
    `  rows:    ${rows.map((r) => `${r.pose.name}@${r.pose.at} ${r.view.name}`).join(", ")}\n` +
    (report.length ? `${[...new Set(report)].join("\n")}\n` : "") +
    `  side is down +X, so forward (-Z) is to the RIGHT: every barrel must point right.`,
);
