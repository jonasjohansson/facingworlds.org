// umesh.mjs — read a UE1 vertex-animated mesh (UMesh / ULodMesh) out of a package.
//
// Enough to rebuild the geometry: the per-frame vertex positions, the triangles with
// their UVs, and the mesh's own Scale/Origin/RotOrigin. No umodel step in between — the
// package has all of it, and an intermediate .3d file is one more thing to get wrong.
//
// ---------------------------------------------------------------------------
// THE LAYOUT, AND THE ONE PLACE IT SURPRISES
// ---------------------------------------------------------------------------
// UMesh::Serialize runs Verts, Tris, AnimSeqs, Connects — and then serializes a
// BoundingBox and BoundingSphere A SECOND TIME, as single values rather than arrays,
// before VertLinks. Treating those 41 bytes as another lazy array reads their float data
// as a file offset and walks off the end of the package. The per-frame BoundingBoxes and
// BoundingSpheres arrays come later, after Textures, and those really are arrays.
//
// TLazyArray is what makes this cheap: each one begins with the absolute file offset of
// whatever follows it, so a reader that does not want the contents just jumps.
import { readProperties } from "./upkg.mjs";

function compactIndex(buf, o) {
  let b = buf[o.p++];
  const negative = (b & 0x80) !== 0;
  let value = b & 0x3f;
  if (b & 0x40) {
    let shift = 6;
    for (let i = 0; i < 4; i++) {
      b = buf[o.p++];
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
  }
  return negative ? -value : value;
}

const FBOX = 25; // two FVectors and a validity byte
const FSPHERE = 16; // an FVector and a radius

/** A vertex is packed into one dword: 11 bits of X, 11 of Y, 10 of Z, each signed. */
function unpackVert(dw) {
  let x = dw & 0x7ff;
  let y = (dw >> 11) & 0x7ff;
  let z = (dw >> 22) & 0x3ff;
  if (x > 1023) x -= 2048;
  if (y > 1023) y -= 2048;
  if (z > 511) z -= 1024;
  return [x, y, z];
}

export function readMesh(pkg, name) {
  const { buf } = pkg;
  const exp = pkg.exports.find((e) => e.name === name && /Mesh$/.test(pkg.classOf(e)));
  if (!exp) throw new Error(`${name}: no mesh export`);
  const end = exp.offset + exp.size;
  const o = { p: exp.offset };
  readProperties(pkg, o, end); // a mesh's own tagged properties, usually none
  o.p += FBOX + FSPHERE; // UPrimitive

  // --- Verts, read rather than skipped ---
  const vertsEnd = buf.readInt32LE(o.p);
  o.p += 4;
  const vertCount = compactIndex(buf, o);
  const packed = new Uint32Array(vertCount);
  for (let i = 0; i < vertCount; i++) packed[i] = buf.readUInt32LE(o.p + i * 4);
  o.p = vertsEnd;

  // --- Tris ---
  const trisEnd = buf.readInt32LE(o.p);
  o.p += 4;
  const triCount = compactIndex(buf, o);
  const tris = [];
  for (let i = 0; i < triCount; i++) {
    const b = o.p + i * 16;
    tris.push({
      v: [buf.readUInt16LE(b), buf.readUInt16LE(b + 2), buf.readUInt16LE(b + 4)],
      type: buf[b + 6],
      color: buf[b + 7],
      uv: [
        [buf[b + 8], buf[b + 9]],
        [buf[b + 10], buf[b + 11]],
        [buf[b + 12], buf[b + 13]],
      ],
      texture: buf[b + 14],
      flags: buf[b + 15],
    });
  }
  o.p = trisEnd;

  // --- AnimSeqs (a plain array, so it has to be walked) ---
  const seqCount = compactIndex(buf, o);
  const anims = [];
  for (let i = 0; i < seqCount; i++) {
    const seqName = pkg.names[compactIndex(buf, o)];
    const group = pkg.names[compactIndex(buf, o)];
    const startFrame = buf.readInt32LE(o.p);
    const numFrames = buf.readInt32LE(o.p + 4);
    o.p += 8;
    const notifyCount = compactIndex(buf, o);
    for (let j = 0; j < notifyCount; j++) {
      o.p += 4; // Time
      compactIndex(buf, o); // Function
    }
    const rate = buf.readFloatLE(o.p);
    o.p += 4;
    anims.push({ name: seqName, group, startFrame, numFrames, rate });
  }

  o.p = buf.readInt32LE(o.p); // Connects
  o.p += FBOX + FSPHERE; // the second, singular BoundingBox/BoundingSphere — see above
  o.p = buf.readInt32LE(o.p); // VertLinks

  const textureCount = compactIndex(buf, o);
  const textures = [];
  for (let i = 0; i < textureCount; i++) textures.push(pkg.resolve(compactIndex(buf, o)));

  const boxCount = compactIndex(buf, o);
  o.p += boxCount * FBOX;
  const sphereCount = compactIndex(buf, o);
  o.p += sphereCount * FSPHERE;

  const frameVerts = buf.readInt32LE(o.p);
  const animFrames = buf.readInt32LE(o.p + 4);
  o.p += 16; // FrameVerts, AnimFrames, AndFlags, OrFlags
  const vec = () => {
    const v = [buf.readFloatLE(o.p), buf.readFloatLE(o.p + 4), buf.readFloatLE(o.p + 8)];
    o.p += 12;
    return v;
  };
  const scale = vec();
  const origin = vec();
  const rotOrigin = [buf.readInt32LE(o.p), buf.readInt32LE(o.p + 4), buf.readInt32LE(o.p + 8)];
  o.p += 12;

  if (frameVerts <= 0 || animFrames <= 0) {
    throw new Error(`${name}: implausible frameVerts=${frameVerts} animFrames=${animFrames}`);
  }
  if (packed.length < frameVerts * animFrames) {
    throw new Error(
      `${name}: ${packed.length} packed vertices is short of ${frameVerts}x${animFrames}`,
    );
  }

  /** Frame `f` as an array of [x, y, z] in mesh-local units, before Scale and Origin. */
  const frame = (f) => {
    const out = [];
    for (let i = 0; i < frameVerts; i++) out.push(unpackVert(packed[f * frameVerts + i]));
    return out;
  };

  o.p += 8; // CurPoly, CurVertex
  // TextureLOD, added to UMesh at package version 66 and present in every UT99 package.
  // Miss it and the LodMesh section below starts two floats early, which reads a wedge
  // index of 9216 out of what is really the tail of a 1.0.
  if (pkg.version >= 66) {
    const lodCount = compactIndex(buf, o);
    o.p += lodCount * 4;
  }

  // -------------------------------------------------------------------------
  // ULodMesh
  // -------------------------------------------------------------------------
  // For a LodMesh the UMesh Tris array above is EMPTY and the geometry is here instead,
  // split into Wedges (a vertex index plus its UV) and Faces (three wedges and a
  // material). Reading Tris and stopping gives a mesh with no triangles at all rather
  // than an error, which is how this was first missed.
  const words = () => {
    const n = compactIndex(buf, o);
    o.p += n * 2;
    return n;
  };
  words(); // CollapsePointThus
  words(); // FaceLevel
  const faceCount = compactIndex(buf, o);
  const faces = [];
  for (let i = 0; i < faceCount; i++) {
    const b = o.p + i * 8;
    faces.push({
      w: [buf.readUInt16LE(b), buf.readUInt16LE(b + 2), buf.readUInt16LE(b + 4)],
      material: buf.readUInt16LE(b + 6),
    });
  }
  o.p += faceCount * 8;
  words(); // CollapseWedgeThus
  const wedgeCount = compactIndex(buf, o);
  const wedges = [];
  for (let i = 0; i < wedgeCount; i++) {
    const b = o.p + i * 4;
    wedges.push({ v: buf.readUInt16LE(b), u: buf[b + 2], vv: buf[b + 3] });
  }
  o.p += wedgeCount * 4;
  const materialCount = compactIndex(buf, o);
  const materials = [];
  for (let i = 0; i < materialCount; i++) {
    materials.push({
      polyFlags: buf.readUInt32LE(o.p + i * 8),
      textureIndex: buf.readInt32LE(o.p + i * 8 + 4),
    });
  }
  o.p += materialCount * 8;
  const specialFaceCount = compactIndex(buf, o);
  o.p += specialFaceCount * 8;
  const modelVerts = buf.readInt32LE(o.p);
  const specialVerts = buf.readInt32LE(o.p + 4);
  o.p += 8;

  // A wedge's vertex index counts from AFTER the special vertices, which are anchors
  // rather than geometry. Zero for a projectile; three for every player mesh.
  const maxWedgeVert = wedges.length ? Math.max(...wedges.map((w) => w.v)) : -1;
  if (maxWedgeVert + specialVerts >= frameVerts) {
    throw new Error(
      `${name}: wedge vertex ${maxWedgeVert} + ${specialVerts} special is outside ${frameVerts}`,
    );
  }

  return {
    name, tris, faces, wedges, materials, anims, textures,
    frameVerts, animFrames, specialVerts, modelVerts,
    scale, origin, rotOrigin, frame,
  };
}
