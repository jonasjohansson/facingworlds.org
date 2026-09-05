// utex.test.mjs — that the UE1 texture reader agrees with umodel.
//
// scripts/lib/utex.mjs exists because umodel is no longer installed, and it decodes the
// thing UE1 has a known way of getting subtly wrong: a palettized image, where swapping
// two channels turns everything blue and nothing throws.
//
// assets/3d/projectiles/rocket/s0.png is committed and was written by umodel back when it
// WAS installed, from JuRocket1 in Botpack.u. That makes it a fixed reference this reader
// can be held against — the same source texture, decoded two entirely different ways.
//
// SKIPPED without a retail install, because Botpack.u is not in this repo and never will
// be. The reference PNG is, so the day the install comes back the check runs again.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { loadPackage } from "../../scripts/lib/upkg.mjs";
import { readTexture } from "../../scripts/lib/utex.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const BOTPACK = path.join(os.homedir(), "Downloads", "Unreal Tournament", "System", "Botpack.u");
const REFERENCE = path.join(ROOT, "assets", "3d", "projectiles", "rocket", "s0.png");

/** Just enough PNG to read our own committed output: RGBA8, non-interlaced. */
function readPng(file) {
  const b = fs.readFileSync(file);
  let p = 8;
  let w = 0;
  let h = 0;
  let colorType = 0;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString("ascii", p + 4, p + 8);
    if (type === "IHDR") {
      w = b.readUInt32BE(p + 8);
      h = b.readUInt32BE(p + 12);
      colorType = b[p + 17];
    } else if (type === "IDAT") idat.push(b.subarray(p + 8, p + 8 + len));
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = w * ch;
  const out = Buffer.alloc(w * h * ch);
  let q = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[q++];
    const line = raw.subarray(q, q + stride);
    q += stride;
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const bb = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += bb;
      else if (filter === 3) v += (a + bb) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(bb - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + bb - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? bb : c;
      }
      cur[i] = v & 255;
    }
    cur.copy(out, y * stride);
  }
  return { w, h, ch, data: out };
}

const haveRetail = fs.existsSync(BOTPACK);

test("the UE1 texture reader reproduces umodel's own export exactly", { skip: !haveRetail && "no retail UT99 install" }, () => {
  const pkg = loadPackage(fs.readFileSync(BOTPACK));
  const img = readTexture(pkg, "JuRocket1");
  const ref = readPng(REFERENCE);

  assert.equal(img.width, ref.w, "width");
  assert.equal(img.height, ref.h, "height");

  let worst = 0;
  let swapped = 0;
  const n = ref.w * ref.h;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      worst = Math.max(worst, Math.abs(ref.data[i * ref.ch + c] - img.rgba[i * 4 + c]));
    }
    // umodel's RED against this reader's BLUE. If the two decoders disagreed about
    // channel order this would be the small number and `worst` the large one.
    swapped += Math.abs(ref.data[i * ref.ch] - img.rgba[i * 4 + 2]);
  }
  assert.equal(worst, 0, `worst per-channel difference was ${worst}, expected an exact match`);

  // Without this the test would also pass on a greyscale image with the channels
  // swapped, which is exactly the bug it is here to catch. The reference has real
  // colour in it, so red and blue must genuinely differ.
  assert.ok(
    swapped / n > 1,
    `red and blue differ by only ${(swapped / n).toFixed(2)} on average — this reference ` +
      `cannot detect a channel swap, so the match above proves less than it appears to`,
  );
});

test("a texture whose palette shares its name with others gets ITS OWN palette", { skip: !haveRetail && "no retail UT99 install" }, () => {
  // UE1 auto-names palettes "Palette<N>" per texture GROUP, so one package holds several
  // unrelated objects called Palette75. The reader used to look the palette up by name
  // and take the first, which handed the Enforcer's muzzle flash (Muz1, group Skins) the
  // BoltHit group's palette and drew it green. JuRocket1 above cannot catch that: its
  // Palette681 is the only one of that name. Muz1's is the fourth of four.
  const pkg = loadPackage(fs.readFileSync(BOTPACK));
  const namesakes = pkg.exports.filter((e) => e.name === "Palette75" && pkg.classOf(e) === "Palette");
  assert.ok(namesakes.length > 1, `expected several Palette75 exports, found ${namesakes.length}`);

  const img = readTexture(pkg, "Muz1");
  // A muzzle flash is a warm burst: over the lit pixels red must dominate green, and
  // green blue. Under the BoltHit palette green dominated everything.
  let r = 0, g = 0, b = 0, lit = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const R = img.rgba[i * 4], G = img.rgba[i * 4 + 1], B = img.rgba[i * 4 + 2];
    if (R + G + B < 60) continue;
    r += R; g += G; b += B; lit++;
  }
  assert.ok(lit > 100, "the flash has lit pixels");
  assert.ok(r >= g && g > b, `expected a warm burst, got mean rgb ${(r / lit).toFixed(0)} ${(g / lit).toFixed(0)} ${(b / lit).toFixed(0)}`);
});
