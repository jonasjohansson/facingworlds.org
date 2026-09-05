// thirdperson.test.mjs — that the gun in the OTHER player's hands is a gun, in a hand,
// pointing forwards.
//
// These run on the committed weapon table and the committed glTFs with no retail install,
// because the failure mode here is the one this repo has now met twice: extraction that
// goes wrong AFTER it succeeds. Six of the eight character bodies ran backwards for months
// while every glTF stayed valid, every model stood at the right height and every clip
// played; the Redeemer's view model spent a while floating five metres from the camera
// with a correctly computed barrel tip. A weapon hung on a remote avatar can fail in
// exactly those two ways — turned round, or displaced — and neither throws.
//
// So nothing below reads an `extras` note or a manifest claim about orientation. The
// numbers are measured off the vertices, and they are measured against the BODY: a
// third-person weapon is not a free-floating model, it is lifted onto the same 39-unit
// pawn cylinder the characters are, so "is it in a hand" is a question this file can
// actually ask.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The SHARED table, not server/weapons.js: a third-person model is a client-rendering
// concern and the server's twin deliberately carries only what the server reasons about.
import { WEAPONS } from "../../src/shared/weapons.js";
// ...and the roster, because where a weapon goes is a fact about the BODY holding it.
import { MODELS } from "../../src/shared/characters.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// These meshes carry NO lift. Their vertices are the weapon's own actor-frame geometry
// about its own origin, because UE1 draws a carried item at the owner pawn's weapon
// triangle with that triangle's orientation — the body's weaponAnchor node supplies the
// whole placement, position and rotation both. So the file's own box has to sit ON its
// origin; a lift left in it would put every gun a metre above the hand it is parented to.
const ON_ORIGIN_M = 0.6;
// Sideways and fore-and-aft about that origin: forward is -Z. A weapon reaches forward from
// the hand and hangs a little below it. The Sniper Rifle's box centre is furthest forward at
// -0.42 m, the Rocket Launcher furthest back at -0.21; nothing is more than 6 cm off centre.
const HAND_SIDE_M = 0.5;
const HAND_FRONT_M = -1.0;
const HAND_BACK_M = 0.3;
// Where the Soldier's own gun fist is, measured off his committed Idle pose (the
// forward-most cluster of his upper body), and how close the anchor has to put a weapon to
// it. 20 cm is deliberately loose: the anchor is Epic's attachment triangle rather than a
// fitted number and lands 5-9 cm out on a humanoid, and the fist is itself a centroid.
// This is here to catch the placement being dropped or halved, not to pin it.
const SOLDIER_FIST_M = [0.119, 1.343, -0.492];
const IN_HAND_M = 0.2;
// How long a UT99 weapon plus the arm holding it is. The lower bound catches a missing
// Mesh.Scale; the upper is set by RifleHand, which really is 1.73 m from muzzle to elbow —
// Epic authored the third-person meshes big, and the SniperRifle PICKUP mesh in this same
// repo is 1.15 m of gun with no arm on it at all.
const SHORTEST_M = 0.3;
const LONGEST_M = 1.8;

/** A very small glTF reader: enough for what scripts/build-ut-thirdperson.mjs writes. */
function readGltf(rel) {
  const file = path.join(ROOT, rel);
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

/** The base pose's bounding box, measured off POSITION rather than read off the manifest. */
function measured(rel) {
  const { g, read } = readGltf(rel);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const prim of g.meshes[0].primitives) {
    const p = read(prim.attributes.POSITION);
    for (let i = 0; i < p.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (p[i + a] < min[a]) min[a] = p[i + a];
        if (p[i + a] > max[a]) max[a] = p[i + a];
      }
    }
  }
  return {
    g,
    min,
    max,
    size: [0, 1, 2].map((a) => max[a] - min[a]),
    centre: [0, 1, 2].map((a) => (min[a] + max[a]) / 2),
  };
}

test("every weapon has a third-person model, and the files are there", () => {
  for (const [id, w] of Object.entries(WEAPONS)) {
    assert.ok(w.third, `${id} has no third-person model`);
    assert.match(w.third.model, /^assets\/3d\/thirdperson\/.+\.gltf$/, `${id} model path`);
    const file = path.join(ROOT, w.third.model);
    assert.ok(fs.existsSync(file), `${id}: ${w.third.model} is missing`);
    // The .bin and the skins beside it, because a glTF that resolves to nothing renders as
    // nothing and says so only in a browser console.
    const g = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const uri of [...g.buffers.map((b) => b.uri), ...(g.images || []).map((i) => i.uri)]) {
      assert.ok(
        fs.existsSync(path.join(path.dirname(file), uri)),
        `${id}: ${uri} is referenced but missing`,
      );
    }
    assert.equal(w.third.muzzleLocal.length, 3, `${id} muzzle`);
  }
});

test("a gun points forward, which in this frame is -Z", () => {
  // The orientation is baked into the vertices — there is no rotation for the client to
  // apply and therefore none for it to compose wrongly — so the claim has to be geometric.
  // A held weapon is longest along the barrel, and the barrel points away from its owner.
  for (const [id, w] of Object.entries(WEAPONS)) {
    const m = measured(w.third.model);
    assert.equal(
      m.size.indexOf(Math.max(...m.size)),
      2,
      `${id}: longest along ${"XYZ"[m.size.indexOf(Math.max(...m.size))]}, not Z — ` +
        `it is turned (${m.size.map((v) => v.toFixed(3)).join(" x ")} m)`,
    );
    // ...and the muzzle is at the FRONT of it. A weapon turned 180 degrees still passes the
    // longest-axis test and puts its muzzle at MAXIMUM z, missing by the whole gun.
    assert.ok(
      w.third.muzzleLocal[2] - m.min[2] <= 0.06 * m.size[2] + 1e-3,
      `${id}: muzzle z is ${w.third.muzzleLocal[2]} but the model's front is ` +
        `${m.min[2].toFixed(4)} — the barrel is not pointing forward`,
    );
  }
});

test("weapons are the size of weapons plus the arm holding one", () => {
  for (const [id, w] of Object.entries(WEAPONS)) {
    const longest = Math.max(...measured(w.third.model).size);
    assert.ok(longest >= SHORTEST_M, `${id} is only ${longest.toFixed(3)} m — a scale is missing`);
    assert.ok(
      longest <= LONGEST_M,
      `${id} is ${longest.toFixed(3)} m — a scale is applied twice`,
    );
  }
});

test("every weapon sits on its own origin, with no lift baked in", () => {
  // The anchor node supplies the placement now, so a translation left in the geometry is
  // added twice. An earlier build lifted these onto the nominal pawn cylinder, which put
  // every box centre 0.92 m up; that has to be gone.
  for (const [id, w] of Object.entries(WEAPONS)) {
    const { centre } = measured(w.third.model);
    assert.ok(
      Math.hypot(...centre) < ON_ORIGIN_M,
      `${id}: its box centre is ${centre.map((v) => v.toFixed(3)).join(", ")} m from its own ` +
        `origin — it is displaced, and the anchor will displace it again`,
    );
    assert.ok(
      Math.abs(centre[0]) < HAND_SIDE_M,
      `${id}: its centre is ${centre[0].toFixed(3)} m off the body's centre line`,
    );
    assert.ok(
      centre[2] > HAND_FRONT_M && centre[2] < HAND_BACK_M,
      `${id}: its centre is at z ${centre[2].toFixed(3)} — a held weapon reaches forward ` +
        `(-Z) and does not trail behind the body`,
    );
  }
});

test("the muzzle is a point on the weapon it belongs to", () => {
  // A barrel tip cannot be outside the mesh's own box. The tolerance is a hair for float
  // rounding, not room for a wrong answer — this is the check that catches a mesh being
  // displaced wholesale while staying internally consistent.
  const EPS = 1e-3;
  for (const [id, w] of Object.entries(WEAPONS)) {
    const { min, max } = measured(w.third.model);
    w.third.muzzleLocal.forEach((v, a) => {
      assert.ok(
        v >= min[a] - EPS && v <= max[a] + EPS,
        `${id}: muzzle axis ${"xyz"[a]} is ${v}, outside the mesh's ${min[a]}..${max[a]}`,
      );
    });
  }
});

test("the manifest's box and the geometry's box are the same box", () => {
  // Two numbers written from two places: gen-weapons.mjs passes the extractor's measurement
  // through, and this measures the vertices. They agree by construction, so a disagreement
  // means one of the two was regenerated against something else.
  const EPS = 1e-3;
  for (const [id, w] of Object.entries(WEAPONS)) {
    const m = measured(w.third.model);
    for (let a = 0; a < 3; a++) {
      assert.ok(Math.abs(w.third.sizeM[a] - m.size[a]) < EPS, `${id}: sizeM[${a}] disagrees`);
      assert.ok(Math.abs(w.third.bboxM.min[a] - m.min[a]) < EPS, `${id}: bbox min[${a}] disagrees`);
      assert.ok(Math.abs(w.third.bboxM.max[a] - m.max[a]) < EPS, `${id}: bbox max[${a}] disagrees`);
    }
  }
});

test("the two meshes that animate carry the clips UT99 plays on them", () => {
  // AutoHand and ASMD2hand are the only third-person meshes with more than one frame, and
  // `anims` is null on the other four. That null is Epic's, not an omission: a UT99 sniper
  // rifle does not move in anyone else's hands, and a client asking "does this weapon
  // animate" should get one answer rather than an empty object to interrogate.
  const ANIMATED = { enforcer: ["Shoot", "shot2"], shock: ["Fire1"] };
  for (const [id, w] of Object.entries(WEAPONS)) {
    const want = ANIMATED[id];
    if (!want) {
      assert.equal(w.third.anims, null, `${id}: anims should be null, its mesh has one frame`);
      continue;
    }
    assert.ok(w.third.anims, `${id}: no anims`);
    const { g } = readGltf(w.third.model);
    const inGltf = (g.animations || []).map((a) => a.name);
    const listed = [
      ...w.third.anims.fire.map((f) => f.clip),
      ...(w.third.anims.fireRepeat ? [w.third.anims.fireRepeat.clip] : []),
    ];
    assert.deepEqual(listed, want, `${id}: anims name ${listed.join(", ")}`);
    for (const clip of listed) {
      // glTF names are case-sensitive where UnrealScript's are not, which is why the
      // Enforcer's repeat clip is 'shot2' here and 'Shot2' in the script that plays it.
      assert.ok(inGltf.includes(clip), `${id}: "${clip}" is not in the glTF (${inGltf.join(", ")})`);
    }
    for (const f of w.third.anims.fire) {
      assert.ok(f.rate > 0, `${id}: ${f.clip} has a rate of ${f.rate}`);
    }
    assert.equal(typeof w.third.anims.fireLoops, "boolean", `${id}: fireLoops`);
    // Morph targets, not skinning: UT99 weapons are vertex animated, and primitives that
    // disagree about the target count animate one part and freeze another.
    const counts = new Set(g.meshes[0].primitives.map((p) => (p.targets || []).length));
    assert.equal(counts.size, 1, `${id}: primitives carry ${[...counts].join("/")} morph targets`);
    assert.ok([...counts][0] > 0, `${id}: no morph targets, so nothing animates`);
  }
});

test("a body's own offset puts the weapon in that body's hand", () => {
  // THE test, and the one the first version of this file did not have. The geometry above
  // is at the pawn's ACTOR ORIGIN, which is the middle of its chest — 42 cm below and 43 cm
  // behind the Soldier's fist, down where the arm hangs when it is DOWN. It looked fine as
  // numbers (a gun, at pawn height, pointing forward) and looked wrong the moment anyone
  // drew a body around it.
  //
  // The move into the hand comes from the BODY, because a weapon has no wearer: the three
  // "special" vertices every UT99 pawn mesh carries ahead of its geometry are Epic's own
  // weapon attachment, and their midpoint is the hand. Asserted against the Soldier, whose
  // fist is measured off his committed Idle pose: it has to land ON the weapon.
  const offset = MODELS.soldier.weaponOffsetM;
  assert.equal(offset?.length, 3, "the Soldier has no weapon offset");
  for (const [id, w] of Object.entries(WEAPONS)) {
    const { min, max } = measured(w.third.model);
    // The fist has to be ON the weapon, which is the claim that holds for all six however
    // differently shaped they are — picking a "grip point" would need per-weapon knowledge,
    // and on RifleHand the rearmost vertex is an elbow half a metre behind the hand.
    const lo = min.map((v, a) => v + offset[a]);
    const hi = max.map((v, a) => v + offset[a]);
    const d = Math.hypot(
      ...SOLDIER_FIST_M.map((f, a) => Math.max(0, lo[a] - f, f - hi[a])),
    );
    assert.ok(
      d < IN_HAND_M,
      `${id}: with the Soldier's offset the nearest part of it is ${(d * 100).toFixed(1)} cm ` +
        `from his fist — box ${lo.map((v) => v.toFixed(2)).join(",")} .. ` +
        `${hi.map((v) => v.toFixed(2)).join(",")}`,
    );
  }
});
