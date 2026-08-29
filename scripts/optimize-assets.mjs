#!/usr/bin/env node
// Asset pipeline for facingworlds.org
//
// Produces optimized COPIES of the glTF/GLB assets the game actually loads.
// Originals under assets/ are never read-modify-written; output goes to a
// separate directory (default: assets-optimized/) that mirrors the source
// layout. Nothing here runs in the browser — this is a devDependency-only
// tool and the site itself stays dependency-free.
//
// Usage:
//   npm run optimize:assets                 # auto codec, draco geometry
//   npm run optimize:assets -- --codec=webp
//   npm run optimize:assets -- --dry-run
//
// Flags:
//   --codec=auto|webp|ktx2|none  texture codec (auto = ktx2 if `ktx` on PATH, else webp)
//   --geometry=draco|meshopt|none  geometry compression (default draco)
//   --quality=<1-100>            webp quality for colour maps (default 90)
//   --data-quality=<1-100>       webp quality for normal/ORM maps (default 95)
//   --near-lossless              encode normal/ORM maps near-losslessly (~3x larger)
//   --out=<dir>                  output directory (default assets-optimized)
//   --only=<substr>              process only assets whose path contains substr
//   --dry-run                    print the plan and exit without writing
//   --keep-intermediates         leave the per-stage temp files on disk

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, copyFileSync } from "node:fs";
import { dirname, join, relative, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = join(REPO_ROOT, "assets");
const GLTF_TRANSFORM = join(REPO_ROOT, "node_modules", ".bin", "gltf-transform");

// ---- what the game actually downloads ----
// Only assets referenced from index.html / src/ are listed. Everything else in
// assets/ (klp.glb, the 8192px earth PNGs, the tracker images, the 30 MB EXR)
// is unreferenced by the game and is better deleted than compressed — see the
// "Unreferenced assets" note in README.md.
//
// textureSize is the max edge length; sources smaller than this are left alone.
// The map's normal/ORM maps carry real detail so they stay at 2048; the
// first-person pistol never fills more than a corner of the screen, so its
// 4096 albedo is cut to 2048 with no visible loss.
const ASSETS = [
  {
    src: "3d/map/FacingWorlds_tex_5.gltf",
    out: "3d/map/FacingWorlds_tex_5.glb",
    textureSize: 2048,
    note: "CTF-Face map; 3 external 2048 PNGs get packed into the .glb",
  },
  {
    src: "3d/enforcer.glb",
    out: "3d/enforcer.glb",
    textureSize: 2048,
    note: "first-person pistol; 4096 albedo is the entire file",
  },
  {
    src: "3d/Soldier.glb",
    out: "3d/Soldier.glb",
    textureSize: 1024,
    note: "player avatar, skinned + 4 animation clips",
  },
  {
    src: "3d/navmesh.gltf",
    out: "3d/navmesh.glb",
    textureSize: 0, // untextured collision geometry
    note: "navigation mesh; geometry only",
  },
];

// ---- argv ----
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const OPTIONS = {
  codec: flag("codec", "auto"),
  geometry: flag("geometry", "draco"),
  quality: Number(flag("quality", "90")),
  dataQuality: Number(flag("data-quality", "95")),
  nearLossless: has("near-lossless"),
  outDir: resolve(REPO_ROOT, flag("out", "assets-optimized")),
  only: flag("only", ""),
  dryRun: has("dry-run"),
  keepIntermediates: has("keep-intermediates"),
};

// ---- guards ----
// The whole point is non-destructive output. Refuse to aim at assets/.
// macOS (APFS/HFS+) and Windows are case-insensitive by default, so `--out=Assets`
// resolves to the same directory as assets/ and would overwrite the originals.
// The comparison is therefore case-insensitive everywhere; that is deliberately
// over-strict on a case-sensitive filesystem, where it costs only the ability to
// name an output directory something that differs from "assets" by case alone.
const outRelToAssets = relative(SOURCE_ROOT.toLowerCase(), OPTIONS.outDir.toLowerCase());
if (outRelToAssets === "" || (!outRelToAssets.startsWith("..") && !outRelToAssets.startsWith("/"))) {
  console.error(`refusing to write inside the source tree: ${OPTIONS.outDir}`);
  console.error("pick an --out directory outside assets/ so the originals stay intact");
  process.exit(1);
}

if (!existsSync(GLTF_TRANSFORM)) {
  console.error("@gltf-transform/cli is not installed.");
  console.error("run `npm install` first (it is a devDependency, not shipped to the browser)");
  process.exit(1);
}

// ---- codec selection ----
// KTX2/Basis encoding is done by the `ktx` binary from KTX-Software, which is a
// separate native install (brew install ktx). gltf-transform shells out to it,
// so if it is missing we fall back to WebP rather than dying halfway through.
const hasKtx = (() => {
  try {
    execFileSync("ktx", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let codec = OPTIONS.codec;
if (codec === "auto") codec = hasKtx ? "ktx2" : "webp";
if (codec === "ktx2" && !hasKtx) {
  console.error("--codec=ktx2 requested but the `ktx` binary is not on PATH.");
  console.error("install KTX-Software (brew install ktx) or use --codec=webp");
  process.exit(1);
}
if (!["webp", "ktx2", "none"].includes(codec)) {
  console.error(`unknown --codec=${codec}`);
  process.exit(1);
}
if (!["draco", "meshopt", "none"].includes(OPTIONS.geometry)) {
  console.error(`unknown --geometry=${OPTIONS.geometry}`);
  process.exit(1);
}

// ---- helpers ----
const bytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};

const size = (p) => statSync(p).size;

// gltf-transform matches --slots as a glob, so a plain comma list silently
// matches nothing and leaves every texture untouched. Braces are required.
const COLOR_SLOTS = "{baseColorTexture,emissiveTexture}";
const DATA_SLOTS = "{normalTexture,occlusionTexture,metallicRoughnessTexture}";

// gltf-transform prints an objc dylib warning on macOS when two sharp copies are
// present; it is noise, so stderr is only surfaced when the command fails.
const gltf = (subcommand, extra = []) => {
  try {
    execFileSync(GLTF_TRANSFORM, [subcommand, ...extra], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    throw new Error(`gltf-transform ${subcommand} failed:\n${detail}`);
  }
};

// ---- pipeline ----
// Each asset is walked through a chain of temp files so a failure in a late
// stage cannot leave a half-written file in the output directory.
function optimize(asset, workDir) {
  const srcPath = join(SOURCE_ROOT, asset.src);
  const outPath = join(OPTIONS.outDir, asset.out);
  const stem = basename(asset.out, ".glb");

  let current = join(workDir, `${stem}.0.glb`);
  let stage = 0;
  const next = (label) => join(workDir, `${stem}.${++stage}.${label}.glb`);

  // 0. normalize to a self-contained .glb (pulls the map's external PNGs in)
  gltf("copy", [srcPath, current]);

  // 1. structural cleanup: drop unused nodes/materials/accessors, merge
  //    duplicate meshes and textures, flatten redundant node hierarchy.
  let step = next("prune");
  gltf("prune", [current, step]);
  current = step;

  step = next("dedup");
  gltf("dedup", [current, step]);
  current = step;

  // 2. texture resize. Skipped only for untextured assets (textureSize 0).
  //    gltf-transform's resize never upscales, so a source already at or below
  //    the target passes through unchanged in pixels — it just costs a re-encode.
  if (asset.textureSize > 0) {
    step = next("resize");
    gltf("resize", [current, step, "--width", String(asset.textureSize), "--height", String(asset.textureSize)]);
    current = step;
  }

  // 3. texture codec, in two passes.
  //    Colour maps are perceptual and tolerate aggressive lossy compression.
  //    Normal and ORM maps are *data* — their channels are read as vectors and
  //    scalars by the shader, so block artifacts show up as shading noise. They
  //    get the gentler setting even though it costs bytes.
  //
  //    webp  — EXT_texture_webp, decoded natively by three.js GLTFLoader, so it
  //            needs zero app-side wiring. Shrinks download only; the GPU still
  //            stores the texture as uncompressed RGBA.
  //    ktx2  — KHR_texture_basisu, stays block-compressed on the GPU too, but
  //            needs a Basis transcoder wired into the loader (see README).
  if (asset.textureSize > 0 && codec === "webp") {
    step = next("webp-color");
    gltf("webp", [current, step, "--slots", COLOR_SLOTS, "--quality", String(OPTIONS.quality)]);
    current = step;

    step = next("webp-data");
    const dataOpts = OPTIONS.nearLossless
      ? ["--near-lossless", "true"]
      : ["--quality", String(OPTIONS.dataQuality)];
    gltf("webp", [current, step, "--slots", DATA_SLOTS, ...dataOpts]);
    current = step;
  } else if (asset.textureSize > 0 && codec === "ktx2") {
    // etc1s is small but destroys normal maps, so colour goes to etc1s and the
    // data maps go to uastc, which keeps per-channel precision. --rdo and
    // --mipmaps are boolean flags; --zstd supercompresses the UASTC payload,
    // which costs nothing at runtime because it is undone before upload.
    step = next("etc1s");
    gltf("etc1s", [current, step, "--slots", COLOR_SLOTS, "--quality", "255", "--mipmaps", "true"]);
    current = step;

    step = next("uastc");
    gltf("uastc", [current, step, "--slots", DATA_SLOTS, "--level", "4", "--rdo", "--zstd", "18", "--mipmaps", "true"]);
    current = step;
  }

  // 4. geometry compression. The meshes here are small (the map is 3.2k tris,
  //    the pistol 17.7k) so this is a minor win in absolute bytes — but once
  //    the textures are compressed, raw f32 vertex data is most of what is left.
  if (OPTIONS.geometry === "draco") {
    step = next("draco");
    gltf("draco", [current, step]);
    current = step;
  } else if (OPTIONS.geometry === "meshopt") {
    step = next("meshopt");
    gltf("meshopt", [current, step]);
    current = step;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  copyFileSync(current, outPath);

  return { srcPath, outPath, before: size(srcPath), after: size(outPath) };
}

// The map's .gltf keeps its geometry and textures in sibling files, so the
// honest "before" figure is the .gltf plus every buffer and image URI it
// actually references — not everything that happens to sit in the same folder.
function sourceFootprint(asset) {
  const srcPath = join(SOURCE_ROOT, asset.src);
  if (!srcPath.endsWith(".gltf")) return size(srcPath);

  const dir = dirname(srcPath);
  const json = JSON.parse(readFileSync(srcPath, "utf8"));
  const uris = [...(json.buffers || []), ...(json.images || [])]
    .map((r) => r.uri)
    .filter((uri) => uri && !uri.startsWith("data:")); // data: URIs are already counted in the .gltf

  const referenced = new Set(uris.map((uri) => join(dir, decodeURIComponent(uri))));
  return [...referenced].filter(existsSync).reduce((sum, f) => sum + size(f), size(srcPath));
}

// ---- run ----
const selected = ASSETS.filter((a) => !OPTIONS.only || a.src.includes(OPTIONS.only));

const codecLabel =
  codec === "webp"
    ? `webp colour q${OPTIONS.quality} / data ${OPTIONS.nearLossless ? "near-lossless" : `q${OPTIONS.dataQuality}`}`
    : codec === "ktx2"
      ? "ktx2 colour etc1s / data uastc"
      : "none";
console.log(`textures: ${codecLabel}   geometry: ${OPTIONS.geometry}`);
console.log(`output:   ${relative(REPO_ROOT, OPTIONS.outDir)}/`);
if (!hasKtx && codec === "webp") {
  console.log("note:     `ktx` not found — using WebP. brew install ktx for KTX2/Basis.");
}
console.log("");

if (OPTIONS.dryRun) {
  for (const asset of selected) {
    console.log(`  ${asset.src}  ->  ${asset.out}   (${asset.note})`);
  }
  console.log("\ndry run — nothing written");
  process.exit(0);
}

const workDir = mkdtempSync(join(tmpdir(), "fw-assets-"));
const results = [];
let failed = 0;

for (const asset of selected) {
  process.stdout.write(`  ${asset.src} ... `);
  try {
    const before = sourceFootprint(asset);
    const r = optimize(asset, workDir);
    results.push({ asset, before, after: r.after });
    const pct = ((1 - r.after / before) * 100).toFixed(1);
    console.log(`${bytes(before)} -> ${bytes(r.after)}  (-${pct}%)`);
  } catch (err) {
    failed++;
    console.log("FAILED");
    console.error(`    ${err.message.split("\n").join("\n    ")}`);
  }
}

if (!OPTIONS.keepIntermediates) rmSync(workDir, { recursive: true, force: true });

if (results.length) {
  const before = results.reduce((s, r) => s + r.before, 0);
  const after = results.reduce((s, r) => s + r.after, 0);
  console.log("");
  console.log(`  total  ${bytes(before)} -> ${bytes(after)}  (-${((1 - after / before) * 100).toFixed(1)}%)`);
}

if (failed) {
  console.error(`\n${failed} asset(s) failed`);
  process.exit(1);
}

console.log("\nOriginals under assets/ are untouched — they are this script's input only.");
console.log(`index.html loads ${relative(REPO_ROOT, OPTIONS.outDir)}/, which is COMMITTED: GitHub Pages`);
console.log("serves the repo as-is with no build step, so `git add` the regenerated files or");
console.log("the deployed site keeps the previous ones.");
