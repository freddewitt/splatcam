// Encodeur PNG 16 bits, RGB, sans dépendance : la compression zlib vient de `CompressionStream('deflate')`
// (le format « deflate » du navigateur est le flux zlib attendu par le chunk IDAT, Adler-32 compris).
//
// Les données d'entrée sont des flottants display-referred dans [0, 1] (sortie de la chaîne de post, déjà
// encodée sRGB) : on quantifie à 65535 sans passer par un canvas 8 bits.

import { crc32 } from './crc32';

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Chunk PNG : longueur, type, données, CRC (calculé sur type + données). */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Flottant [0, 1] → entier 16 bits (arrondi, écrêté). */
export function toUint16(v: number): number {
  return v <= 0 || Number.isNaN(v) ? 0 : v >= 1 ? 65535 : Math.round(v * 65535);
}

/**
 * Scanlines PNG brutes : un octet de filtre (0 = aucun) puis w × 3 échantillons 16 bits big-endian par ligne.
 * `rgba` : flottants RGBA entrelacés, ligne 0 = haut de l'image ; alpha ignoré.
 */
export function rawScanlines(rgba: Float32Array, w: number, h: number): Uint8Array {
  const stride = 1 + w * 6;
  const raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    let o = y * stride + 1;
    let i = y * w * 4;
    for (let x = 0; x < w; x++, i += 4) {
      for (let c = 0; c < 3; c++) {
        const q = toUint16(rgba[i + c]);
        raw[o++] = q >> 8;
        raw[o++] = q & 0xff;
      }
    }
  }
  return raw;
}

/** Compresse en zlib (flux « deflate » du navigateur). */
export async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Décompresse un flux zlib (tests et relecture). */
export async function zlibInflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** PNG RGB 16 bits (balise sRGB : les valeurs sont encodées sRGB par la chaîne de post). */
export async function encodePng16(rgba: Float32Array, w: number, h: number): Promise<Uint8Array> {
  if (rgba.length < w * h * 4) throw new Error(`encodePng16 : ${rgba.length} valeurs pour ${w}×${h} RGBA`);
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 16;  // profondeur de bits
  ihdr[9] = 2;   // couleur vraie RGB
  // compression 0, filtre 0, entrelacement 0
  const idat = await zlibDeflate(rawScanlines(rgba, w, h));
  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('sRGB', new Uint8Array([0])), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
