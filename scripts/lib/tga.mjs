// tga.mjs — read the TGAs umodel writes.
//
// umodel emits type 10: run-length encoded, 32-bit BGRA, origin bottom-left. Only that
// is handled, and anything else throws rather than being guessed at — a silently
// mis-decoded texture is a subtle wrongness that survives every other check.
export function readTga(buf) {
  const idLength = buf[0];
  const colorMapType = buf[1];
  const imageType = buf[2];
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  const bpp = buf[16];
  const descriptor = buf[17];
  if (colorMapType !== 0) throw new Error(`TGA: colour-mapped images not handled`);
  if (imageType !== 2 && imageType !== 10) throw new Error(`TGA: image type ${imageType} not handled`);
  if (bpp !== 32 && bpp !== 24) throw new Error(`TGA: ${bpp} bits per pixel not handled`);

  const bytes = bpp / 8;
  let p = 18 + idLength;
  const pixels = Buffer.alloc(width * height * 4);
  let out = 0;
  const total = width * height;

  const put = (b, g, r, a) => {
    pixels[out++] = r;
    pixels[out++] = g;
    pixels[out++] = b;
    pixels[out++] = a;
  };

  if (imageType === 2) {
    for (let i = 0; i < total; i++) {
      put(buf[p], buf[p + 1], buf[p + 2], bytes === 4 ? buf[p + 3] : 255);
      p += bytes;
    }
  } else {
    let done = 0;
    while (done < total) {
      const packet = buf[p++];
      const count = (packet & 0x7f) + 1;
      if (packet & 0x80) {
        const b = buf[p], g = buf[p + 1], r = buf[p + 2], a = bytes === 4 ? buf[p + 3] : 255;
        p += bytes;
        for (let i = 0; i < count; i++) put(b, g, r, a);
      } else {
        for (let i = 0; i < count; i++) {
          put(buf[p], buf[p + 1], buf[p + 2], bytes === 4 ? buf[p + 3] : 255);
          p += bytes;
        }
      }
      done += count;
    }
  }

  // Bit 5 of the descriptor is the origin: clear means the first row written is the
  // BOTTOM one, which is the usual case and needs flipping for anything that expects
  // top-down. Getting this wrong renders the world upside down, which at least announces
  // itself; getting it wrong on a symmetrical explosion sprite would not.
  const topDown = (descriptor & 0x20) !== 0;
  if (!topDown) {
    const row = width * 4;
    const flipped = Buffer.alloc(pixels.length);
    for (let y = 0; y < height; y++) {
      pixels.copy(flipped, y * row, (height - 1 - y) * row, (height - y) * row);
    }
    return { width, height, rgba: flipped };
  }
  return { width, height, rgba: pixels };
}
