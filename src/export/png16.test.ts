import { describe, expect, it } from 'vitest';
import { crc32 } from './crc32';
import { encodePng16, rawScanlines, toUint16, zlibInflate } from './png16';

/** Chunks d'un PNG : [type, données]. */
function chunks(png: Uint8Array): [string, Uint8Array][] {
  const out: [string, Uint8Array][] = [];
  const v = new DataView(png.buffer, png.byteOffset);
  for (let o = 8; o < png.length;) {
    const len = v.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const data = png.subarray(o + 8, o + 8 + len);
    expect(v.getUint32(o + 8 + len)).toBe(crc32(png.subarray(o + 4, o + 8 + len)));
    out.push([type, data]);
    o += 12 + len;
  }
  return out;
}

describe('crc32', () => {
  it('valeur connue', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('est chaînable', () => {
    const a = new TextEncoder().encode('1234'), b = new TextEncoder().encode('56789');
    expect(crc32(b, crc32(a))).toBe(0xcbf43926);
  });
});

describe('toUint16', () => {
  it('quantifie sur 16 bits et écrête', () => {
    expect([toUint16(0), toUint16(1), toUint16(0.5), toUint16(-1), toUint16(7), toUint16(NaN)]).toEqual([0, 65535, 32768, 0, 65535, 0]);
  });
  it('garde la résolution 16 bits (un 8 bits les confondrait)', () => {
    expect(toUint16(0.5 + 1 / 65535)).not.toBe(toUint16(0.5));
  });
});

describe('encodePng16', () => {
  it('écrit une signature, un IHDR 16 bits RGB et un IEND valides', async () => {
    const png = await encodePng16(new Float32Array(3 * 2 * 4), 3, 2);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const cs = chunks(png);
    expect(cs.map(([t]) => t)).toEqual(['IHDR', 'sRGB', 'IDAT', 'IEND']);
    const ih = new DataView(cs[0][1].buffer, cs[0][1].byteOffset);
    expect([ih.getUint32(0), ih.getUint32(4), cs[0][1][8], cs[0][1][9]]).toEqual([3, 2, 16, 2]);
  });

  it('restitue exactement les pixels une fois décompressé', async () => {
    const w = 5, h = 4;
    const px = new Float32Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { px[4 * i] = i / (w * h); px[4 * i + 1] = 1 - i / (w * h); px[4 * i + 2] = (i % 7) / 7; px[4 * i + 3] = 1; }
    const png = await encodePng16(px, w, h);
    const idat = chunks(png).find(([t]) => t === 'IDAT')![1];
    const raw = await zlibInflate(idat);
    expect(raw).toEqual(rawScanlines(px, w, h));
    // Pixel (x=2, y=1) : filtre 0 en tête de ligne, puis 6 octets par pixel, big-endian.
    const i = 1 * w + 2, o = 1 * (1 + w * 6) + 1 + 2 * 6;
    expect(raw[1 * (1 + w * 6)]).toBe(0);
    expect((raw[o] << 8) | raw[o + 1]).toBe(toUint16(px[4 * i]));
    expect((raw[o + 2] << 8) | raw[o + 3]).toBe(toUint16(px[4 * i + 1]));
    expect((raw[o + 4] << 8) | raw[o + 5]).toBe(toUint16(px[4 * i + 2]));
  });

  it('refuse un tampon trop court', async () => {
    await expect(encodePng16(new Float32Array(8), 3, 2)).rejects.toThrow();
  });
});
