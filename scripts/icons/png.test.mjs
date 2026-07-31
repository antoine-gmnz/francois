import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, encodePng } from './png.mjs';

describe('crc32', () => {
  it('matches the standard CRC-32 check value for "123456789"', () => {
    // The canonical test vector for this exact algorithm/polynomial.
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926);
  });

  it('is 0 for an empty buffer', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe('encodePng', () => {
  it('rejects a buffer of the wrong length', () => {
    expect(() => encodePng(2, 2, new Uint8ClampedArray(3))).toThrow();
  });

  it('starts with the PNG signature', () => {
    const rgba = new Uint8ClampedArray(2 * 2 * 4);
    const png = encodePng(2, 2, rgba);
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('writes an IHDR chunk with the requested dimensions, 8-bit RGBA, no interlacing', () => {
    const rgba = new Uint8ClampedArray(3 * 5 * 4);
    const png = encodePng(3, 5, rgba);
    // signature(8) + length(4) + "IHDR"(4) = offset 16 for the IHDR data.
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    const ihdr = png.subarray(16, 16 + 13);
    expect(ihdr.readUInt32BE(0)).toBe(3); // width
    expect(ihdr.readUInt32BE(4)).toBe(5); // height
    expect(ihdr[8]).toBe(8); // bit depth
    expect(ihdr[9]).toBe(6); // colour type: RGBA
    expect(ihdr[12]).toBe(0); // interlace: none
  });

  it('ends with an empty IEND chunk', () => {
    const rgba = new Uint8ClampedArray(2 * 2 * 4);
    const png = encodePng(2, 2, rgba);
    // IEND is always length 0, so the trailing 12 bytes are length+type+crc.
    const tail = png.subarray(png.length - 12);
    expect(tail.readUInt32BE(0)).toBe(0);
    expect(tail.subarray(4, 8).toString('ascii')).toBe('IEND');
  });

  it('round-trips real pixel data through the zlib IDAT stream', () => {
    const width = 4;
    const height = 3;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 17) % 256;

    const png = encodePng(width, height, rgba);

    // Walk the chunk list to find IDAT, rather than assuming its offset.
    let offset = 8;
    let idat = null;
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const type = png.subarray(offset + 4, offset + 8).toString('ascii');
      const data = png.subarray(offset + 8, offset + 8 + length);
      if (type === 'IDAT') idat = data;
      offset += 8 + length + 4;
    }
    expect(idat).not.toBeNull();

    const raw = inflateSync(idat);
    const stride = width * 4;
    expect(raw.length).toBe((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      expect(raw[y * (stride + 1)]).toBe(0); // "no filter" byte
      const row = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
      expect(Array.from(row)).toEqual(Array.from(rgba.subarray(y * stride, y * stride + stride)));
    }
  });
});
