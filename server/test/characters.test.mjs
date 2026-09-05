// characters.test.mjs — that the eight bodies stand on the floor, at human size, and RUN
// THE WAY THE RIG POINTS.
//
// These run on the committed glTFs with no retail install, because the failure this exists
// for happened after extraction and survived every check there was. The old extractor
// never applied Mesh.RotOrigin; docs/ut99-character-extraction.md wrote that down as a
// rule ("read the axis off RotOrigin and assert it matches the tallest axis of the idle
// pose"), which fixes UP and nothing else. So every model stood exactly 1.830 m tall,
// every clip played, every skin fitted — and six of the eight faced +Z while the rig's
// forward is -Z. Six of eight ran backwards, in the game, for months. It was found by
// photographing a commando bot from in front and seeing the back of his head.
//
// The fix went in as geometry (scripts/build-ut-characters.mjs bakes Epic's rotator in),
// so the test has to be geometry too. Nothing here reads a yaw field or an `extras` note:
// every number below is measured off the vertices the client will draw.
//
// THE PLANTED-FOOT METHOD, which is what makes "which way does it face" measurable at all:
// a UT99 run cycle is a treadmill — the pawn stays at the origin and the ground is what
// moves — so the foot in contact with the ground slides BACKWARDS through the mesh at
// exactly the speed the body is going forwards. Sum that slide over the cycle and negate
// it. It does not care which boot is in front, which is what the discredited heuristic
// behind the old `YAW_FIX = { skaarj: 90, warcow: 90 }` cared about: that one read the
// stance, not the body, and turned the two models that were closest to right.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// The clips the client binds by name. src/game/components/remote-avatar.js keys its weight
// blend on exactly these three strings and src/ar/three/players.js does the same, so a
// renamed clip is an avatar frozen in its base pose with no error anywhere.
const CLIPS = ["Idle", "Walk", "Run"];

// Every UT99 pawn walks around in a 39-unit half-height collision cylinder, whatever its
// mesh measures, and the game is built against the cylinder: 2 * 39 * UU_TO_M = 1.833 m.
// The tolerance is loose enough not to pin the extractor's exact fit and tight enough that
// a body scaled to its own mesh height (1.80 to 2.07 m raw) fails.
const STANDING_HEIGHT_M = 1.83;
const HEIGHT_TOLERANCE_M = 0.05;
// The rig's position is the FLOOR, so a body whose feet are not on y = 0 either hovers or
// sinks. 2 cm is a centimetre of float error either side of nothing.
const FEET_TOLERANCE_M = 0.02;
// 15 degrees off -Z. Generous on purpose: the point is to catch 90 and 180, not to re-pin
// the extractor's own 2-degree self-check.
const HEADING_TOLERANCE_DEG = 15;

/** A very small glTF reader: enough for what scripts/build-ut-characters.mjs writes. */
function readGltf(id) {
  const file = path.join(ROOT, "assets", "3d", "characters", id, `${id}.gltf`);
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
 * The frames of one clip, each as an array of [x, y, z].
 *
 * The clips are one-hot morph weights, so a keyframe IS a UT99 frame and no interpolation
 * is wanted. A looping clip ends on a repeat of its first frame so the wrap is not a jump;
 * that duplicate is dropped here, because the planted-foot sum below closes the cycle
 * itself and counting the first frame twice would weight it double.
 */
function clipFrames(id, clipName) {
  const { g, read } = readGltf(id);
  const anim = g.animations.find((a) => a.name === clipName);
  assert.ok(anim, `${id}: no "${clipName}" animation`);
  const sampler = anim.samplers[anim.channels[0].sampler];
  const times = read(sampler.input);
  const weights = read(sampler.output);
  const nTargets = weights.length / times.length;

  const prim = g.meshes[0].primitives[0];
  const base = read(prim.attributes.POSITION);
  const targets = (prim.targets || []).map((t) => read(t.POSITION));
  assert.equal(targets.length, nTargets, `${id}/${clipName}: weights do not match target count`);

  const rowOf = (k) => Array.from({ length: nTargets }, (_, t) => weights[k * nTargets + t]);
  let count = times.length;
  if (count > 1) {
    const [first, last] = [rowOf(0), rowOf(count - 1)];
    if (first.every((w, i) => w === last[i])) count -= 1;
  }

  const frames = [];
  for (let k = 0; k < count; k++) {
    const p = new Float32Array(base);
    for (let t = 0; t < nTargets; t++) {
      const w = weights[k * nTargets + t];
      if (!w) continue;
      const d = targets[t];
      for (let i = 0; i < p.length; i++) p[i] += w * d[i];
    }
    const pts = [];
    for (let i = 0; i < p.length; i += 3) pts.push([p[i], p[i + 1], p[i + 2]]);
    frames.push(pts);
  }
  return frames;
}

/** Degrees off -Z that a body runs, by the planted-foot method described in the header. */
function runHeadingDeg(frames) {
  const ys = frames[0].map((p) => p[1]);
  const minY = Math.min(...ys);
  const height = Math.max(...ys) - minY;
  // The boots: the bottom 6% of the standing height in the cycle's first frame. "Planted"
  // is a boot within 4% of the floor in the frame it is moving OUT of — a foot in mid-swing
  // is higher than that and contributes nothing.
  const lowCut = minY + height * 0.06;
  const plantCut = minY + height * 0.04;
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (let k = 0; k < frames.length; k++) {
    const a = frames[k];
    const b = frames[(k + 1) % frames.length];
    for (let i = 0; i < a.length; i++) {
      if (frames[0][i][1] > lowCut) continue;
      if (a[i][1] > plantCut) continue;
      sx += b[i][0] - a[i][0];
      sz += b[i][2] - a[i][2];
      n++;
    }
  }
  assert.ok(n > 0, "no planted foot vertices in the run cycle");
  // Negated: the ground slides back, the body goes forward. Forward is -Z, so zero degrees
  // is dead ahead and the old bug reads as 180.
  return { deg: (Math.atan2(-sx, sz) * 180) / Math.PI, samples: n };
}

const MODELS = await import("../../src/shared/characters.js").then((m) => Object.keys(m.MODELS));

test("all eight UT99 bodies are present", () => {
  assert.equal(MODELS.length, 8, `roster is ${MODELS.join(", ")}`);
  for (const id of MODELS) {
    const file = path.join(ROOT, "assets", "3d", "characters", id, `${id}.gltf`);
    assert.ok(fs.existsSync(file), `${id}: ${path.relative(ROOT, file)} is missing`);
  }
});

test("every body carries the Idle, Walk and Run clips the client binds by name", () => {
  for (const id of MODELS) {
    const { g } = readGltf(id);
    const names = (g.animations || []).map((a) => a.name);
    for (const clip of CLIPS) {
      assert.ok(names.includes(clip), `${id}: no "${clip}" clip — has ${names.join(", ")}`);
    }
    // Morph targets, not skinning: UT99 characters are vertex animated, and an avatar whose
    // primitives disagree about the target count animates one body part and freezes another.
    const counts = new Set(g.meshes[0].primitives.map((p) => (p.targets || []).length));
    assert.equal(counts.size, 1, `${id}: primitives carry ${[...counts].join("/")} morph targets`);
    assert.ok([...counts][0] > 0, `${id}: no morph targets, so nothing animates`);
  }
});

test("every body stands on the floor at cylinder height", () => {
  for (const id of MODELS) {
    // The base pose IS the Idle clip's first frame — it is what the model shows with all
    // morph weights at zero, so it is the frame these have to be true of.
    const first = clipFrames(id, "Idle")[0];
    const ys = first.map((p) => p[1]);
    const [lo, hi] = [Math.min(...ys), Math.max(...ys)];
    assert.ok(
      Math.abs(lo) <= FEET_TOLERANCE_M,
      `${id}: the idle pose's lowest vertex is ${lo.toFixed(4)} m, not on the floor`,
    );
    assert.ok(
      Math.abs(hi - lo - STANDING_HEIGHT_M) <= HEIGHT_TOLERANCE_M,
      `${id}: stands ${(hi - lo).toFixed(3)} m, not ${STANDING_HEIGHT_M}`,
    );
    // Up is Y after the extraction's UT -> world swap. A body lying down passes the height
    // check by accident if the tallest axis is not asserted.
    const ext = [0, 1, 2].map(
      (a) => Math.max(...first.map((p) => p[a])) - Math.min(...first.map((p) => p[a])),
    );
    assert.equal(
      ext.indexOf(Math.max(...ext)),
      1,
      `${id}: tallest along ${"XYZ"[ext.indexOf(Math.max(...ext))]}, not Y`,
    );
  }
});

test("every body runs the way the rig points, which is -Z", () => {
  // THE test. The rig's yaw comes off the wire and the server's bots set it to
  // atan2(-dx, -dz), i.e. the rig faces its own motion along -Z; a body that runs +Z inside
  // that rig runs backwards down the map.
  const report = [];
  for (const id of MODELS) {
    const { deg, samples } = runHeadingDeg(clipFrames(id, "Run"));
    report.push(`${id} ${deg.toFixed(1)}`);
    assert.ok(samples >= 4, `${id}: only ${samples} planted-foot samples to measure with`);
    assert.ok(
      Math.abs(deg) <= HEADING_TOLERANCE_DEG,
      `${id}: runs ${deg.toFixed(1)} degrees off -Z (${report.join(", ")})`,
    );
  }
});

test("no model needs a yaw correction, and every variant still resolves to one", async () => {
  const { MODELS: TABLE, VARIANTS, CHARACTER_COUNT, modelYaw } = await import(
    "../../src/shared/characters.js"
  );
  // Zero for all eight is the FIX, not an omission: the rotator is baked into the geometry
  // above, so there is nothing left for the client to turn. The field and modelYaw() stay
  // because network.js and the AR players table both apply them and a future mesh may need
  // one — what must not come back is a fitted number standing in for a transform.
  for (const id of Object.keys(TABLE)) {
    assert.equal(TABLE[id].yawDeg, 0, `${id} should need no correction`);
  }
  // A silent undefined here would be applied as a rotation of NaN.
  for (let i = 0; i < CHARACTER_COUNT; i++) {
    assert.equal(typeof modelYaw(i), "number", `variant ${i} (${VARIANTS[i]})`);
    assert.ok(Number.isFinite(modelYaw(i)), `variant ${i} yaw is not finite`);
  }
});

test("every material slot has the skin file the client will hang on it", () => {
  // remote-avatar.js reads the slot number off the material name — /slot(\d+)$/ — and puts
  // urls[i] on it, and those URLs come from the generated roster's per-skin file list. A
  // model with more slots than a skin has files silently renders that part untextured.
  for (const id of MODELS) {
    const { g } = readGltf(id);
    g.materials.forEach((m, i) => {
      assert.equal(m.name, `slot${i}`, `${id}: material ${i} is named "${m.name}"`);
    });
    const dir = path.join(ROOT, "assets", "3d", "characters", id);
    for (const skin of fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory())) {
      const pngs = fs.readdirSync(path.join(dir, skin)).filter((f) => f.endsWith(".png"));
      assert.equal(
        pngs.length,
        g.materials.length,
        `${id}/${skin}: ${pngs.length} skin files for ${g.materials.length} material slots`,
      );
    }
  }
});
