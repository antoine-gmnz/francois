// Zero-dependency PNG encoder: an 8-bit RGBA buffer in, PNG bytes out. No
// filesystem access here — render-icon.mjs writes the result to disk — so
// this stays a pure function, testable by decompressing what it produces.
//
// A PNG is: the 8-byte signature, then a run of length-prefixed chunks
// (IHDR, IDAT, IEND, …), each `length(4) + type(4 ascii) + data + crc32(4)`.
// The only Node builtin this needs is `node:zlib` for the IDAT payload
// (a plain zlib stream, which is also what a PNG chunk expects) — CRC-32
// isn't exposed by zlib, so it's the one algorithm implemented by hand below
// (the standard 256-entry table method).

import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (the one PNG/zip use), over a Buffer. */
export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/**
 * Encode a straight-alpha RGBA byte buffer (row-major, 4 bytes/px, as
 * produced by raster.mjs's `renderIconRGBA`) as PNG bytes.
 */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: buffer length ${rgba.length} does not match ${width}x${height}x4`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression method (the only one PNG defines)
  ihdr[11] = 0; // filter method (the only one PNG defines)
  ihdr[12] = 0; // interlace: none

  // One leading "no filter" byte per scanline, per the PNG spec.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw);

  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
