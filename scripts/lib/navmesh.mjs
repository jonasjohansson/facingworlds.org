// navmesh.mjs — read the shipped navmesh at build time and answer "what is the
// walkable surface here?"
//
// Used by scripts/gen-map-actors.mjs. The actor table (Epic's own coordinates, put
// through src/shared/map-transform.js) is authoritative for WHERE something is in
// plan; the navmesh is authoritative for WHAT IT STANDS ON. The fit that maps Unreal
// Units onto this fan model is good to ~0.25 scene units on the outdoor actors but
// over a unit inside the tower alcoves, and the fan model has small holes the real
// level does not — so a converted x/z can land a metre off the mesh even though the
// original actor was on solid floor. Trusting the raw fit there produces a flag stand
// hanging in the air, or a PlayerStart the navmesh constraint has to rescue.
//
// This is the build-time twin of what src/game/player/spawn.js does at runtime with a
// THREE.Raycaster: cast straight down, and if nothing is under you, walk to the
// nearest walkable polygon. Doing it here means the whole set is validated once, in
// the generator, instead of one point at a time by whoever happens to spawn there.
//
// Reads assets/3d/navmesh.gltf — the UNCOMPRESSED source. The game loads the Draco'd
// copy in assets-optimized/, which scripts/optimize-assets.mjs writes from this same
// file with the same WORLD_SCALE, so the two agree to the quantization step (~16 mm).
import fs from "node:fs";
import path from "node:path";

const COMPONENT_READERS = {
  5121: (buf, off) => buf.readUInt8(off), // UNSIGNED_BYTE
  5123: (buf, off) => buf.readUInt16LE(off), // UNSIGNED_SHORT
  5125: (buf, off) => buf.readUInt32LE(off), // UNSIGNED_INT
};
const COMPONENT_BYTES = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };

function bufferBytes(gltf, index, gltfPath) {
  const uri = gltf.buffers[index].uri;
  const m = /^data:[^,]*;base64,(.*)$/s.exec(uri || "");
  if (m) return Buffer.from(m[1], "base64");
  // A sibling .bin, which is how the map mesh ships (assets/3d/map/*.gltf + .bin)
  // while the navmesh inlines its buffer. Resolved against the glTF's own directory,
  // never against the working directory, and confined to it: a URI is a relative path
  // in someone else's file, not a licence to read anywhere on disk.
  if (!uri) throw new Error(`glTF buffer ${index} has no uri (GLB is not supported)`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) throw new Error(`glTF buffer ${index} uri is not a local file: ${uri}`);
  const dir = path.dirname(gltfPath);
  const file = path.resolve(dir, decodeURIComponent(uri));
  if (path.relative(dir, file).startsWith("..")) throw new Error(`glTF buffer ${index} escapes its directory: ${uri}`);
  return fs.readFileSync(file);
}

function readAccessor(gltf, buffers, accessorIndex) {
  const acc = gltf.accessors[accessorIndex];
  const view = gltf.bufferViews[acc.bufferView];
  const buf = buffers[view.buffer];
  const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const comps = acc.type === "VEC3" ? 3 : 1;
  const size = COMPONENT_BYTES[acc.componentType];
  const stride = view.byteStride || comps * size;
  const read = acc.componentType === 5126 ? (b, o) => b.readFloatLE(o) : COMPONENT_READERS[acc.componentType];
  if (!read) throw new Error(`unsupported componentType ${acc.componentType}`);
  const out = new Float64Array(acc.count * comps);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < comps; c++) out[i * comps + c] = read(buf, base + i * stride + c * size);
  }
  return out;
}

/**
 * Every triangle of the navmesh, in final scene coordinates.
 *
 * `scale` is WORLD_SCALE: optimize-assets.mjs bakes it into the root node's transform
 * on the way to assets-optimized/, and the navmesh's single node is otherwise the
 * identity, so multiplying the vertices here is the same geometry the game loads.
 */
export function loadNavmesh(gltfPath, scale = 1) {
  const gltf = JSON.parse(fs.readFileSync(gltfPath, "utf8"));
  const buffers = gltf.buffers.map((_, i) => bufferBytes(gltf, i, gltfPath));
  const tris = [];

  // world = k * v + a, accumulated down the hierarchy. Rotations are rejected rather
  // than handled: the navmesh has none, and silently ignoring one would be worse.
  const walk = (nodeIndex, k, a) => {
    const node = gltf.nodes[nodeIndex];
    const t = node.translation || [0, 0, 0];
    const s = node.scale || [1, 1, 1];
    if (node.rotation && node.rotation.some((v, i) => Math.abs(v - (i === 3 ? 1 : 0)) > 1e-6)) {
      throw new Error("navmesh node carries a rotation; this loader only handles translate+scale");
    }
    if (node.matrix) throw new Error("navmesh node carries a matrix; this loader only handles TRS");
    const nk = [k[0] * s[0], k[1] * s[1], k[2] * s[2]];
    const na = [k[0] * t[0] + a[0], k[1] * t[1] + a[1], k[2] * t[2] + a[2]];
    if (node.mesh != null) {
      for (const prim of gltf.meshes[node.mesh].primitives) {
        if (prim.mode != null && prim.mode !== 4) continue; // TRIANGLES only
        const pos = readAccessor(gltf, buffers, prim.attributes.POSITION);
        const idx =
          prim.indices != null
            ? readAccessor(gltf, buffers, prim.indices)
            : Float64Array.from({ length: pos.length / 3 }, (_, i) => i);
        for (let i = 0; i < idx.length; i += 3) {
          const v = [];
          for (let c = 0; c < 3; c++) {
            const p = idx[i + c] * 3;
            v.push([pos[p] * nk[0] + na[0], pos[p + 1] * nk[1] + na[1], pos[p + 2] * nk[2] + na[2]]);
          }
          tris.push(v);
        }
      }
    }
    for (const child of node.children || []) walk(child, nk, na);
  };

  const scene = gltf.scenes[gltf.scene || 0];
  for (const n of scene.nodes) walk(n, [scale, scale, scale], [0, 0, 0]);
  if (!tris.length) throw new Error(`no triangles found in ${gltfPath}`);
  return new Navmesh(tris);
}

const EPS = 1e-9;

class Navmesh {
  constructor(tris) {
    this.tris = tris.map((v) => {
      const [a, b, c] = v;
      return {
        a,
        b,
        c,
        minX: Math.min(a[0], b[0], c[0]),
        maxX: Math.max(a[0], b[0], c[0]),
        minZ: Math.min(a[2], b[2], c[2]),
        maxZ: Math.max(a[2], b[2], c[2]),
        cx: (a[0] + b[0] + c[0]) / 3,
        cz: (a[2] + b[2] + c[2]) / 3,
      };
    });
  }

  /** Surface heights at (x, z), one per polygon that covers the point in plan. */
  heightsAt(x, z) {
    const out = [];
    for (const t of this.tris) {
      if (x < t.minX - EPS || x > t.maxX + EPS || z < t.minZ - EPS || z > t.maxZ + EPS) continue;
      const y = barycentricY(t, x, z);
      if (y != null) out.push(y);
    }
    return out;
  }

  /** Closest point ON the mesh, in plan, to (x, z) — used when nothing is underfoot. */
  nearestInPlan(x, z, preferY, yWindow) {
    let best = null;
    let bestWindowed = null;
    for (const t of this.tris) {
      const p = closestPointInPlan(t, x, z);
      if (!best || p.d2 < best.d2) best = { t, ...p };
      if (Math.abs(p.y - preferY) <= yWindow && (!bestWindowed || p.d2 < bestWindowed.d2)) bestWindowed = { t, ...p };
    }
    return bestWindowed || best;
  }
}

function barycentricY(t, x, z) {
  const { a, b, c } = t;
  const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
  if (Math.abs(d) < EPS) return null; // degenerate in plan (a vertical wall polygon)
  const w0 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
  const w1 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
  const w2 = 1 - w0 - w1;
  const tol = 1e-7;
  if (w0 < -tol || w1 < -tol || w2 < -tol) return null;
  return w0 * a[1] + w1 * b[1] + w2 * c[1];
}

/** Closest point to (x, z) inside a triangle's plan projection, with its height. */
function closestPointInPlan(t, x, z) {
  const inside = barycentricY(t, x, z);
  if (inside != null) return { x, z, y: inside, d2: 0 };
  let best = null;
  const edges = [
    [t.a, t.b],
    [t.b, t.c],
    [t.c, t.a],
  ];
  for (const [p, q] of edges) {
    const dx = q[0] - p[0];
    const dz = q[2] - p[2];
    const len2 = dx * dx + dz * dz;
    const u = len2 < EPS ? 0 : Math.max(0, Math.min(1, ((x - p[0]) * dx + (z - p[2]) * dz) / len2));
    const px = p[0] + u * dx;
    const pz = p[2] + u * dz;
    const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (!best || d2 < best.d2) best = { x: px, z: pz, y: p[1] + u * (q[1] - p[1]), d2 };
  }
  return best;
}

/**
 * The build-time equivalent of spawn.js's downward raycast — plus the thing a single
 * raycast cannot do: move off a hole.
 *
 * Returns the walkable surface for an actor whose plan position is (x, z) and whose
 * converted height is `preferY`:
 *
 *   - if a polygon covers (x, z) ON THE ACTOR'S OWN STOREY, and there is mesh all
 *     around it, keeps x/z exactly and takes y from that polygon;
 *   - otherwise searches outwards for the closest point that IS on that storey with
 *     `clearance` of mesh in every direction, and reports how far it had to move.
 *
 * The storey window is what stops the blue flag base — which sits over a hole in the
 * fan navmesh with a mid-tower ledge 23 units above it — from being "snapped" up onto
 * that ledge. The clearance ring is what stops the answer being a point balanced on the
 * lip of the hole, which a runtime raycast against the Draco-quantized copy of this
 * mesh could still miss.
 *
 * Positions come back unrounded; the caller rounds once, at emit.
 */
export function snapToSurface(
  nav,
  x,
  z,
  preferY,
  { yWindow = 4, clearance = 0.5, minClearance = 0.25, maxNudge = 6, step = 0.15, spokes = 24 } = {}
) {
  const storeyY = (px, pz) => {
    const hits = nav.heightsAt(px, pz).filter((h) => Math.abs(h - preferY) <= yWindow);
    if (!hits.length) return null;
    return hits.reduce((best, h) => (Math.abs(h - preferY) < Math.abs(best - preferY) ? h : best));
  };
  const clearAt = (px, pz, y, r, n = 12) => {
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const h = nav.heightsAt(px + r * Math.cos(a), pz + r * Math.sin(a));
      if (!h.some((v) => Math.abs(v - y) <= yWindow)) return false;
    }
    return true;
  };

  const here = storeyY(x, z);
  if (here != null && clearAt(x, z, here, minClearance)) return { x, z, y: here, nudge: 0 };

  // Ring search, closest first. Deterministic: fixed step, fixed spoke count, and the
  // first spoke of the first ring that qualifies wins.
  for (let r = step; r <= maxNudge + 1e-9; r += step) {
    let best = null;
    for (let i = 0; i < spokes; i++) {
      const a = (2 * Math.PI * i) / spokes;
      const px = x + r * Math.cos(a);
      const pz = z + r * Math.sin(a);
      const y = storeyY(px, pz);
      if (y == null || !clearAt(px, pz, y, clearance)) continue;
      if (!best || Math.abs(y - preferY) < Math.abs(best.y - preferY)) best = { x: px, z: pz, y, nudge: r };
    }
    if (best) return best;
  }

  if (here != null) return { x, z, y: here, nudge: 0 };
  throw new Error(
    `no navmesh within ${maxNudge} of (${x.toFixed(2)}, ${z.toFixed(2)}) at y~${preferY.toFixed(2)} — ` +
      `the actor table and the map model disagree here, fix by hand`
  );
}
