// ubsp.mjs — read the BSP tree out of a UE1 level package.
//
// A UE1 `.unr` stores its whole world as one `UModel` export: not a mesh, but a binary
// space partition. The geometry is spread over five parallel arrays, and the polygons
// are reconstructed by walking the nodes and indirecting twice — node -> vert pool ->
// point. There is no vertex buffer to lift wholesale.
//
// Used by scripts/build-ut-bsp.mjs. Kept separate from lib/umesh.mjs because a UModel
// and a ULodMesh share nothing but the package format underneath them.
//
// ---------------------------------------------------------------------------
// THE THREE THINGS THAT COST TIME HERE
// ---------------------------------------------------------------------------
// 1. THE ARRAY ORDER IS NOT THE OBVIOUS ONE. It is
//
//        Vectors -> Points -> Nodes -> Surfs -> Vertices
//
//    and not Vectors/Points/Vertices/Nodes, which is what the field order in the
//    class declaration suggests. Getting it wrong does not throw: the Nodes count
//    reads as a plausible number and the first node's FPlane comes out as garbage
//    that still parses. The tell is the FPlane — a real one is a unit normal plus a
//    distance, so `-1.0, -0.0, 0.0, 359.999` is right and `3.7e-41` is not.
//
// 2. `Tris` IS EMPTY, and so is the temptation to use it. The polygons live in
//    Nodes/Vertices. A node's `numVertices` entries start at `iVertPool` in the
//    Vertices array, each of which is an FVert holding a point INDEX.
//
// 3. A NODE POLYGON IS CONVEX, which is the only reason fan triangulation is safe
//    here. BSP nodes are convex by construction — that is what makes it a BSP.
//
// 4. THE WINDING REVERSES ON THE WAY TO SCENE SPACE, and this module does NOT do it
//    for you: the loops come back in Epic's own order. uuToScene() maps
//    (x, y, z) -> (x, z, y), and a coordinate swap has determinant -1 — it carries UT's
//    left-handed world into three.js's right-handed one and flips the sense of every
//    cross product with it. Read a floor triangle in Epic's order after that transform
//    and its normal points at the floor. Whoever converts is the one that has to swap
//    two vertices back, once. It is a silent bug: the geometry is in exactly the right
//    place and only the normals are inside out, so raycasts still hit and only the
//    thing you asked the normal for goes wrong.
//
// The polyflag values below are Epic's own, from the PolyFlags enum. Only the ones
// this repo actually reasons about are named.
export const PF = Object.freeze({
  Invisible: 0x00000001,
  Masked: 0x00000002,
  Translucent: 0x00000004,
  NotSolid: 0x00000008,
  Semisolid: 0x00000020,
  FakeBackdrop: 0x00000080,
  TwoSided: 0x00000100,
  Unlit: 0x00400000,
  Portal: 0x04000000,
  Mirrored: 0x08000000,
});

/**
 * The level's own UModel — the big one.
 *
 * Every brush in the level also serialises a UModel, but those are 71-byte stubs
 * holding a transform and nothing else. CTF-Face has 233 of them around the one that
 * matters, so this picks by size rather than by name: `Model1` is the level model in
 * CTF-Face, but that numbering is an artefact of the order Epic's editor happened to
 * save in and is not a rule.
 */
export function findLevelModel(pkg) {
  const models = pkg.exports.filter((e) => pkg.classOf(e) === "Model");
  if (!models.length) throw new Error("no Model export in this package");
  let best = models[0];
  for (const m of models) if (m.size > best.size) best = m;
  // A level model is hundreds of kilobytes; a brush stub is under a hundred bytes.
  // If the biggest thing here is small, this is not a level package.
  if (best.size < 10000) {
    throw new Error(`largest Model is only ${best.size} bytes — this is not a level package`);
  }
  return best;
}

/**
 * Read a UModel's arrays.
 *
 * Returns { points, nodes, surfs, vertPoint } with points as a flat Float64Array of
 * raw Unreal Units, in UT's own axes (x forward, y right, z up). Converting to scene
 * coordinates is the caller's job — see uuToScene() in src/shared/map-transform.js.
 *
 * `readProperties` is passed in rather than imported so this module stays a pure
 * reader over one export and lib/upkg.mjs keeps ownership of the property format.
 */
export function readModel(pkg, buf, exp, readProperties) {
  const end = exp.offset + exp.size;
  const o = { p: exp.offset };
  readProperties(pkg, o, end);

  // A UModel opens with UPrimitive's bounding box and sphere: FBox is two FVectors
  // plus a validity byte (25), FSphere is an FVector plus a radius (16).
  o.p += 25 + 16;

  const ci = () => {
    let b = buf[o.p++];
    const neg = (b & 0x80) !== 0;
    let v = b & 0x3f;
    if (b & 0x40) {
      let s = 6;
      for (let i = 0; i < 4; i++) {
        b = buf[o.p++];
        v |= (b & 0x7f) << s;
        s += 7;
        if (!(b & 0x80)) break;
      }
    }
    return neg ? -v : v;
  };
  const f32 = () => {
    const v = buf.readFloatLE(o.p);
    o.p += 4;
    return v;
  };
  const i32 = () => {
    const v = buf.readInt32LE(o.p);
    o.p += 4;
    return v;
  };
  const vecArray = () => {
    const n = ci();
    if (n < 0 || o.p + n * 12 > end) throw new Error(`implausible vector array of ${n} at +${o.p - exp.offset}`);
    const out = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      out[i * 3] = f32();
      out[i * 3 + 1] = f32();
      out[i * 3 + 2] = f32();
    }
    return out;
  };

  vecArray(); // Vectors — surface normals and texture axes; the polygons do not need them.
  const points = vecArray();

  const nNodes = ci();
  const nodes = [];
  for (let i = 0; i < nNodes; i++) {
    // FBspNode: the splitting plane, then the polygon this node carries.
    const px = f32(), py = f32(), pz = f32(), pw = f32();
    if (i === 0) {
      // The first plane is the sanity check that the array order above is right. A
      // real FPlane's normal is unit length; garbage is not.
      const len = Math.hypot(px, py, pz);
      if (!(len > 0.9 && len < 1.1)) {
        throw new Error(
          `first BSP plane normal has length ${len.toExponential(3)}, not ~1 — ` +
            `the array order is wrong (expected Vectors, Points, Nodes, Surfs, Vertices)`,
        );
      }
      void pw;
    }
    o.p += 8; // ZoneMask, a QWORD
    const nodeFlags = buf[o.p++];
    const iVertPool = ci();
    const iSurf = ci();
    ci(); // iBack
    ci(); // iFront
    ci(); // iPlane
    ci(); // iCollisionBound
    ci(); // iRenderBound
    o.p += 2; // iZone[2], one byte each
    const numVertices = buf[o.p++];
    i32(); // iLeaf[0]
    i32(); // iLeaf[1]
    nodes.push({ iVertPool, iSurf, numVertices, nodeFlags });
  }

  const nSurfs = ci();
  const surfs = [];
  for (let i = 0; i < nSurfs; i++) {
    const texture = ci();
    const polyFlags = buf.readUInt32LE(o.p);
    o.p += 4;
    const pBase = ci();
    const vNormal = ci();
    const vTextureU = ci();
    const vTextureV = ci();
    const iLightMap = ci();
    const iBrushPoly = ci();
    o.p += 4; // PanU, PanV — two INTs, only meaningful for texturing
    ci(); // Actor
    surfs.push({ texture, polyFlags, pBase, vNormal, vTextureU, vTextureV, iLightMap, iBrushPoly });
  }

  const nVerts = ci();
  const vertPoint = new Int32Array(nVerts);
  for (let i = 0; i < nVerts; i++) {
    vertPoint[i] = ci(); // FVert.pVertex — an index into Points
    ci(); // FVert.iSide
  }

  return { points, nodes, surfs, vertPoint };
}

/**
 * Node polygons as point-index loops, dropping the ones that cannot be trusted.
 *
 * Skips degenerate nodes (fewer than three vertices — BSP leaves carry no polygon)
 * and any node whose vertex run leaves the arrays, which would otherwise read a
 * neighbouring polygon's points and weld two unrelated surfaces together.
 */
export function nodePolys({ points, nodes, surfs, vertPoint }) {
  const polys = [];
  let skipped = 0;
  for (const n of nodes) {
    if (n.numVertices < 3) continue;
    const idx = [];
    let ok = true;
    for (let i = 0; i < n.numVertices; i++) {
      const vi = n.iVertPool + i;
      if (vi < 0 || vi >= vertPoint.length) {
        ok = false;
        break;
      }
      const pv = vertPoint[vi];
      if (pv < 0 || pv * 3 + 2 >= points.length) {
        ok = false;
        break;
      }
      idx.push(pv);
    }
    if (!ok) {
      skipped++;
      continue;
    }
    const surf = n.iSurf >= 0 && n.iSurf < surfs.length ? surfs[n.iSurf] : null;
    polys.push({ idx, polyFlags: surf ? surf.polyFlags : 0, iSurf: n.iSurf });
  }
  return { polys, skipped };
}

/**
 * Group polygons into connected components by shared point index.
 *
 * A UE1 level's Points array is deduplicated across the whole model, so surfaces that
 * touch share indices and land in one component. This is what separates the skybox —
 * a sealed room the player never occupies — from the level proper, without having to
 * decode zones. Returns an array of arrays of indices into `polys`.
 */
export function components(polys) {
  const parent = new Int32Array(polys.length);
  for (let i = 0; i < polys.length; i++) parent[i] = i;
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  };
  const seenAt = new Map();
  polys.forEach((p, i) => {
    for (const pt of p.idx) {
      const prev = seenAt.get(pt);
      if (prev === undefined) seenAt.set(pt, i);
      else union(prev, i);
    }
  });
  const groups = new Map();
  polys.forEach((_, i) => {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(i);
  });
  return [...groups.values()].sort((a, b) => b.length - a.length);
}
