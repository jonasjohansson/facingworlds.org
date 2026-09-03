// utex.mjs — read a UE1 texture out of a package, as RGBA.
//
// This is the reader umodel used to stand in for. It exists because umodel is not
// installed any more and the view-model skins are not shared with any mesh whose
// textures are already committed, so there was nothing left to reuse.
//
// A UE1 texture is PALETTIZED: the pixels are one byte each, indices into a separate
// UPalette object of 256 RGBA entries. That is the part the build-ut-projectiles.mjs
// comment calls "a known way to go subtly wrong" — swap two channels resolving it and
// every texture comes out blue while nothing complains.
//
// So it is not trusted, it is CHECKED. assets/3d/projectiles/rocket/s0.png was exported
// by umodel back when umodel was installed, from JuRocket1 in Botpack.u. Decoding that
// same texture with this reader reproduces it EXACTLY: mean |difference| 0.00 on all
// three channels over all 16,384 pixels. Comparing umodel's red against this reader's
// blue gives 13.67, so the image has real colour in it and the agreement above is a
// result rather than two greyscales matching by construction.
// server/test/utex.test.mjs pins both halves of that.
//
// ---------------------------------------------------------------------------
// THE LAYOUT, AND THE TWO THINGS THAT ARE NOT OBVIOUS
// ---------------------------------------------------------------------------
// After the tagged properties, a UTexture is a TArray of mipmaps, largest first. Each
// FMipmap is:
//
//     ...   DataArray        a TLazyArray<BYTE>: an absolute END offset, then a
//                            compact-index count, then that many bytes
//     INT   USize, VSize
//     BYTE  UBits, VBits
//
// 1. THERE IS NO WidthOffset FIELD, whatever the engine's later versions do. UT99 is
//    package version 69 and a mip begins directly with its lazy array. Skipping four
//    bytes for one eats the lazy offset instead, and then the byte count reads as a
//    small negative number or a wild positive one — which is what it did.
//
// 2. THE LAZY ARRAY'S LEADING INT IS AN ABSOLUTE FILE OFFSET, not a length. It is the
//    position just past the array, which is exactly what makes it skippable without
//    decoding — and it is also the check that the parse is still aligned, because it
//    has to agree with where reading the bytes actually lands. That check is what
//    identified the field above as absent rather than merely mis-sized.
//
// 3. INDEX 0 IS THE TRANSPARENT ONE for a masked texture. UE1 does not store an alpha
//    channel; PF_Masked means "palette entry 0 is a hole". The palette's own alpha
//    bytes are not meaningful and must not be used as coverage — read them and most of
//    these weapons come out fully transparent.
import { readProperties } from "./upkg.mjs";

/** The 256 RGBA entries of a UPalette export. */
function readPalette(pkg, exp) {
  const buf = pkg.buf;
  const end = exp.offset + exp.size;
  const o = { p: exp.offset };
  readProperties(pkg, o, end);
  const n = compactIndex(buf, o);
  if (n < 1 || n > 4096) throw new Error(`palette has an implausible ${n} colours`);
  const colors = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    colors[i * 4] = buf[o.p++];
    colors[i * 4 + 1] = buf[o.p++];
    colors[i * 4 + 2] = buf[o.p++];
    colors[i * 4 + 3] = buf[o.p++];
  }
  return colors;
}

// A local copy: upkg keeps its compact-index reader private, and this module needs one
// for the mip counts. Same encoding — sign in bit 7 of the first byte, continue in bit 6,
// then seven bits per byte after that.
function compactIndex(buf, o) {
  let b = buf[o.p++];
  const neg = (b & 0x80) !== 0;
  let v = b & 0x3f;
  if (b & 0x40) {
    let shift = 6;
    for (let i = 0; i < 4; i++) {
      b = buf[o.p++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
  }
  return neg ? -v : v;
}

/**
 * One texture, as { width, height, rgba }.
 *
 * `masked` makes palette index 0 fully transparent, which is what PF_Masked means in
 * UE1 and what every weapon skin with a cut-out needs. Without it the cut-outs come
 * back as whatever colour happened to sit in slot 0, usually a flat green or black.
 */
export function readTexture(pkg, name, { masked = false } = {}) {
  const exp = pkg.exports.find((e) => e.name === name && /Texture/.test(pkg.classOf(e) || ""));
  if (!exp) throw new Error(`${name}: no Texture export`);

  const buf = pkg.buf;
  const end = exp.offset + exp.size;
  const o = { p: exp.offset };
  const props = readProperties(pkg, o, end);

  // The palette is an object reference in the properties. Without one there is nothing
  // to resolve the indices against and the texture cannot be read at all.
  const palRef = props.Palette;
  const palName = typeof palRef === "string" ? palRef : pkg.resolve(palRef);
  if (!palName) throw new Error(`${name}: no Palette property`);
  const palExp = pkg.exports.find((e) => e.name === palName && pkg.classOf(e) === "Palette");
  if (!palExp) throw new Error(`${name}: palette ${palName} not in this package`);
  const palette = readPalette(pkg, palExp);

  const mipCount = compactIndex(buf, o);
  if (mipCount < 1 || mipCount > 32) throw new Error(`${name}: ${mipCount} mipmaps is implausible`);

  // A ScriptedTexture stores NO bitmap: UT99 draws into it at runtime — the Rocket
  // Launcher's `miniammoled` is a 64x64 LED panel it prints the ammo count onto — and
  // all it carries is the SourceTexture it starts from. Nothing here renders ammo
  // digits, so the source panel is the honest thing to use, and it is a real texture
  // that reads like any other.
  if (props.SourceTexture) {
    const srcName = typeof props.SourceTexture === "string"
      ? props.SourceTexture
      : pkg.resolve(props.SourceTexture);
    if (srcName && srcName !== name) return readTexture(pkg, srcName, { masked });
  }

  // Only mip 0 is wanted, and mip 0 is first, so this reads exactly one.
  const lazyEnd = buf.readInt32LE(o.p);
  o.p += 4;
  const count = compactIndex(buf, o);
  const dataStart = o.p;
  if (count < 0 || dataStart + count > end) {
    throw new Error(`${name}: mip 0 claims ${count} bytes, which does not fit the export`);
  }
  o.p += count;
  // The lazy array's leading INT is where the array ENDS. If that disagrees with where
  // reading it landed, the parse is misaligned and everything after is noise.
  if (lazyEnd !== o.p) {
    throw new Error(`${name}: lazy array ends at ${o.p} but its header says ${lazyEnd}`);
  }
  const width = buf.readInt32LE(o.p);
  const height = buf.readInt32LE(o.p + 4);
  o.p += 8;

  if (width * height !== count) {
    throw new Error(`${name}: ${width}x${height} needs ${width * height} bytes, got ${count}`);
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < count; i++) {
    const idx = buf[dataStart + i] * 4;
    rgba[i * 4] = palette[idx];
    rgba[i * 4 + 1] = palette[idx + 1];
    rgba[i * 4 + 2] = palette[idx + 2];
    // Palette alpha is not coverage in UE1 (see the header). Opaque unless masked, and
    // masked means exactly "index 0 is a hole".
    rgba[i * 4 + 3] = masked && buf[dataStart + i] === 0 ? 0 : 255;
  }
  return { width, height, rgba, palette };
}
