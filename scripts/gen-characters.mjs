#!/usr/bin/env node
// gen-characters.mjs — write the character roster from what is actually on disk.
//
//   node scripts/gen-characters.mjs          # rewrite src/shared/characters.js
//   node scripts/gen-characters.mjs --check  # fail if it is out of date
//
// The roster has to be identical on both sides: the SERVER picks which character a
// player wears so that everyone sees the same one, and the CLIENT turns that pick
// into a model URL and a set of skin textures. A table generated from the asset tree
// cannot drift from the assets the way two hand-written copies would.
//
// Assets come from assets/3d/characters/<model>/, built by scripts/build-ut-characters.mjs
// (see docs/ut99-character-extraction.md): <model>.gltf + .bin, and one directory of skin
// PNGs per named character. Slot count varies by model — the Soldier has four material
// slots, the Female Commando three, the Nali two — so the skin file list is read, not
// assumed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const DIR = path.join(ROOT, "assets", "3d", "characters");
const OUTPUT = path.join(ROOT, "src", "shared", "characters.js");
// The server is CommonJS and lives in its own deploy root, the way nav-graph.js does.
const OUTPUT_SERVER = path.join(ROOT, "server", "characters.js");
const CHECK = process.argv.includes("--check");

// ---------------------------------------------------------------------------
// WHICH WAY A BODY FACES — NOTHING, ANY MORE, AND WHY THAT IS THE FIX
// ---------------------------------------------------------------------------
// This table used to read `{ skaarj: 90, warcow: 90 }` and it was wrong in every part.
//
// The old extractor never applied RotOrigin. docs/ut99-character-extraction.md wrote that
// down as a rule — "read the axis off RotOrigin and assert it matches the tallest axis of
// the idle pose" — which fixes UP, so every model stood at the right height and nothing
// looked broken, while leaving each body free to be turned any way at all about that axis.
// Measured off the committed geometry's own Run clips, SIX OF THE EIGHT faced +Z within
// 2 degrees. The rig's forward is -Z, so six of eight ran backwards. The other two, the
// Skaarj and the cow, were 90 degrees off — and those are exactly the two the +90 above
// rescued, which is the whole story of that table: it fixed the only two bodies that were
// not running backwards and did nothing for the six that were.
//
// It had been fitted to a different measurement, the direction the feet sit forward of the
// body. Which boot is in front depends on where in the stride the sampled frame sits, so
// that reads the stance rather than the body.
//
// scripts/build-ut-characters.mjs now applies Epic's rotator the way the weapons pipeline
// does: mesh vertex x Mesh.Scale, then the TRANSPOSE of FRotationMatrix(RotOrigin) (its
// rows are the rotated frame's axes, so the transpose takes mesh components to actor
// components), then UT (x fwd, y right, z up) -> world (x right, y up, z back). UE1 pawns
// face +X, so through that every body faces -Z — including TSkM and TCowMesh, whose
// RotOrigin is (0, 0, 0) and who therefore have nothing to apply. Verified per model on
// the emitted Run cycle by the planted-foot method, all eight within 2 degrees, and pinned
// by server/test/characters.test.mjs.
//
// So the table is empty and every yawDeg is 0. The FIELD stays, and so does modelYaw():
// src/game/network/network.js and src/ar/three/players.js both apply it, and a per-model
// correction is exactly the kind of thing a future mesh might genuinely need. What it must
// never again be is a fitted number standing in for a transform that was not applied.
const YAW_FIX = {};

// ---------------------------------------------------------------------------
// WHERE A WEAPON SITS ON THIS PARTICULAR BODY
// ---------------------------------------------------------------------------
// THE REAL ANSWER IS NOT HERE, and that is worth saying first. Every character glTF now
// carries an empty node named "weaponAnchor", a sibling of the mesh node, and every clip
// animates its translation AND its rotation. That is the faithful thing: UE1 draws a
// carried item at the pawn's weapon triangle with the triangle's own orientation, the
// triangle is per-frame data, and the hand travels 32 to 86 cm over a run cycle. A client
// parents the weapon to that node and is done.
//
// weaponOffsetM below is the STATIC FALLBACK — that node's base-pose translation — for a
// renderer that cannot parent to a node inside a loaded glTF. It is right for a standing
// body and increasingly wrong the faster it moves.
//
// Where it comes from: every UT99 pawn mesh carries THREE "special" vertices ahead of its
// geometry (umesh.mjs: specialVerts is 3 on all eight bodies, 0 on every weapon). Nothing
// references them — they are not geometry, they are Epic's weapon attachment — and they
// bracket the gun hand: V0 about a hand above the fist, V2 the same below, V1 out along
// the aim. build-ut-characters.mjs writes their midpoint as extras.weaponAnchorM, and it
// lands within 4.8-8.6 cm of each body's own fist on all six humanoids, against 12-16 cm
// for V0 alone and 49-75 cm for the pawn's actor origin — which is where the weapon
// geometry sits, and which is down at the hip where the arm hangs when it is DOWN.
//
// It is the FULL position, not a correction: assets/3d/thirdperson carries no lift at all,
// so its origin is the weapon's own origin and this places the whole thing.
//
// It is not exact — 5-9 cm on a humanoid, 25 cm on the Nali (four arms) and 61 cm on the
// cow (no arms) — and the fist it was measured against is itself a cluster centroid.

/** This body's base-pose weapon anchor: the static fallback for the animated node. */
function weaponOffset(dir, model) {
  const extras = JSON.parse(fs.readFileSync(path.join(dir, `${model}.gltf`), "utf8")).extras || {};
  const a = extras.weaponAnchorM;
  if (!Array.isArray(a) || a.length !== 3) {
    throw new Error(
      `${model}: no extras.weaponAnchorM — rerun node scripts/build-ut-characters.mjs first`,
    );
  }
  return a.map((v) => Math.round(v * 1e6) / 1e6);
}

const models = [];
for (const model of fs.readdirSync(DIR).sort()) {
  const md = path.join(DIR, model);
  if (!fs.statSync(md).isDirectory()) continue;
  const gltf = `${model}.gltf`;
  if (!fs.existsSync(path.join(md, gltf))) throw new Error(`${model}: no ${gltf}`);
  const skins = fs
    .readdirSync(md)
    .filter((n) => fs.statSync(path.join(md, n)).isDirectory())
    .sort()
    .map((skin) => ({
      name: skin,
      slots: fs.readdirSync(path.join(md, skin)).filter((f) => f.endsWith(".png")).sort(),
    }));
  if (!skins.length) throw new Error(`${model}: no skin directories`);
  models.push({
    model,
    gltf,
    skins,
    yawDeg: YAW_FIX[model] ?? 0,
    weaponOffsetM: weaponOffset(md, model),
  });
}
if (!models.length) throw new Error(`no characters under ${path.relative(ROOT, DIR)}`);

// Flat list of every wearable combination, in a stable order: the server indexes into
// this, and an index has to mean the same thing in both processes.
const variants = [];
for (const m of models) for (const s of m.skins) variants.push([m.model, s.name]);

const body = `// GENERATED by scripts/gen-characters.mjs — DO NOT EDIT.
//
// Every playable UT99 character extracted into assets/3d/characters, as one flat list
// the server can index into and the client can turn into URLs.
//
// ${models.length} models, ${variants.length} variants. Each model is one glTF with six morph-target clips —
// Idle, Walk, Run and the firing variants Fire, WalkFire, RunFire — because UT99
// characters are vertex-animated rather than skinned, and one material slot per skin
// texture. The slot count differs per model, so SKINS carries the file list rather than
// a count. weaponOffsetM is where to move a third-person weapon so it sits in THIS
// body's gun hand; see weaponOffset() below.
//
// The server assigns a variant per player and broadcasts the index, so every client
// draws the same body for the same person. See server/characters.js.

const BASE = "assets/3d/characters";

const MODELS = ${JSON.stringify(Object.fromEntries(models.map((m) => [m.model, { gltf: m.gltf, yawDeg: m.yawDeg, weaponOffsetM: m.weaponOffsetM, skins: Object.fromEntries(m.skins.map((s) => [s.name, s.slots])) }])), null, 2)};

const VARIANTS = ${JSON.stringify(variants)};

/**
 * Model URL for a variant index, or null when the index is unknown.
 *
 * \`prefix\` is for pages that are not at the site root: the game is served from /, the
 * AR spectator page from /ar/, and the paths here are relative so both can be hosted
 * under any path prefix. The AR page passes "../", as ar-config.js does for its own
 * assets.
 */
function modelUrl(index, prefix = "") {
  const v = VARIANTS[index];
  if (!v) return null;
  return \`\${prefix}\${BASE}/\${v[0]}/\${MODELS[v[0]].gltf}\`;
}

/** Skin texture URLs, one per material slot, for a variant index. */
function skinUrls(index, prefix = "") {
  const v = VARIANTS[index];
  if (!v) return [];
  return MODELS[v[0]].skins[v[1]].map((f) => \`\${prefix}\${BASE}/\${v[0]}/\${v[1]}/\${f}\`);
}

const CHARACTER_COUNT = VARIANTS.length;

/**
 * Degrees to turn this model so it faces the way the game thinks it does.
 *
 * Zero for all eight, and that is the point: scripts/build-ut-characters.mjs bakes Epic's
 * RotOrigin in, so every body already faces -Z, the rig's forward. It used to be 90 for
 * the Skaarj and the cow, which was a fitted number standing in for a rotator the old
 * extractor never applied — see the note in scripts/gen-characters.mjs.
 *
 * Kept because a future mesh may genuinely need it. Apply it to the MODEL, never to the
 * rig: the rig's yaw is the player's heading and is overwritten from the wire on every
 * pose, so a correction written there is erased by the next packet.
 */
function modelYaw(index) {
  const v = VARIANTS[index];
  if (!v) return 0;
  return MODELS[v[0]].yawDeg || 0;
}

/**
 * Where to put a third-person weapon on THIS body, in metres — the STATIC fallback.
 *
 * PREFER THE ANCHOR NODE. Every character glTF carries an empty node named "weaponAnchor",
 * a sibling of the mesh node in the same space, and every clip animates its translation and
 * its rotation. Parent the weapon to that and the gun follows the hand through the stride,
 * which is what UE1 does — it draws a carried item at the pawn's weapon triangle with the
 * triangle's own orientation, and the triangle is per-frame data.
 *
 * This is that node's BASE-POSE translation, for a renderer that cannot reach inside a
 * loaded glTF. Right for a standing body; the hand moves 32-86 cm over a run cycle, so it
 * is increasingly wrong the faster the body goes, and it carries no rotation at all.
 *
 * It is the FULL position: assets/3d/thirdperson carries no lift, so its origin is the
 * weapon's own origin. Good to 5-9 cm on a humanoid, 25 cm on the Nali, 61 cm on the cow.
 */
function weaponOffset(index) {
  const v = VARIANTS[index];
  if (!v) return [0, 0, 0];
  return MODELS[v[0]].weaponOffsetM || [0, 0, 0];
}

export { BASE, MODELS, VARIANTS, CHARACTER_COUNT, modelUrl, skinUrls, modelYaw, weaponOffset };
`;

const serverBody = `// GENERATED by scripts/gen-characters.mjs — DO NOT EDIT.
//
// The server half of the character roster. It never needs the URLs — only how many
// variants exist and which is which — so this is the list and a picker, nothing more.
//
// WHY THE SERVER CHOOSES. If each client picked its own body for a player, two people
// would see the same bot as different characters, and a bot would change identity on
// every reconnect. The pick is a server fact like the team, broadcast in publicPlayer().

const VARIANTS = ${JSON.stringify(variants)};
const CHARACTER_COUNT = VARIANTS.length;

/**
 * Pick a character for a new player, avoiding the ones already on the map so a
 * ten-bot match is ten different bodies rather than the same face four times.
 * \`taken\` is any iterable of indices currently in use.
 */
function pickCharacter(taken) {
  const used = new Set(taken);
  const free = [];
  for (let i = 0; i < CHARACTER_COUNT; i++) if (!used.has(i)) free.push(i);
  const pool = free.length ? free : Array.from({ length: CHARACTER_COUNT }, (_, i) => i);
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { VARIANTS, CHARACTER_COUNT, pickCharacter };
`;

if (CHECK) {
  const stale = [[OUTPUT, body], [OUTPUT_SERVER, serverBody]].filter(([f, want]) => {
    const current = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    return current !== want;
  });
  if (stale.length) {
    console.error(`${stale.map(([f]) => path.relative(ROOT, f)).join(", ")} out of date — run: node scripts/gen-characters.mjs`);
    process.exit(1);
  }
  console.log("character roster is up to date.");
  process.exit(0);
}
fs.writeFileSync(OUTPUT, body);
fs.writeFileSync(OUTPUT_SERVER, serverBody);
console.log(
  `wrote ${path.relative(ROOT, OUTPUT)} — ${models.length} models, ${variants.length} variants\n` +
    models.map((m) => `  ${m.model.padEnd(10)} ${m.skins.length} skin(s), ${m.skins[0].slots.length} slots: ${m.skins.map((s) => s.name).join(", ")}`).join("\n")
);
