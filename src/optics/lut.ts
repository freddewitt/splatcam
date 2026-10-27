// Looks : lecture des LUT 3D au format Adobe / Resolve `.cube` et mise en forme pour le GPU.
//
// Format : `LUT_3D_SIZE N`, puis N³ lignes « r g b » (le rouge varie le plus vite, puis le vert, puis
// le bleu). Les LUT 1D et les domaines non standards ne sont pas gérés (erreur claire).

export interface Lut3D {
  size: number;
  /** RGB flottants, N³ × 3, ordre r le plus rapide. */
  data: Float32Array;
  title: string;
}

export function parseCube(text: string): Lut3D {
  let size = 0, title = '';
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [key, ...rest] = line.split(/\s+/);
    switch (key) {
      case 'TITLE': title = rest.join(' ').replace(/^"|"$/g, ''); break;
      case 'LUT_3D_SIZE': size = parseInt(rest[0], 10); break;
      case 'LUT_1D_SIZE': throw new Error('LUT 1D non prise en charge (LUT 3D attendue)');
      case 'DOMAIN_MIN': if (rest.some((v) => parseFloat(v) !== 0)) throw new Error('DOMAIN_MIN ≠ 0 non pris en charge'); break;
      case 'DOMAIN_MAX': if (rest.some((v) => parseFloat(v) !== 1)) throw new Error('DOMAIN_MAX ≠ 1 non pris en charge'); break;
      default: {
        const r = parseFloat(key), g = parseFloat(rest[0]), b = parseFloat(rest[1]);
        if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) throw new Error(`Ligne illisible : « ${line.slice(0, 40)} »`);
        vals.push(r, g, b);
      }
    }
  }
  if (!Number.isInteger(size) || size < 2) throw new Error('LUT_3D_SIZE manquant ou invalide');
  if (vals.length !== size ** 3 * 3) throw new Error(`${vals.length / 3} entrées lues, ${size ** 3} attendues`);
  return { size, data: Float32Array.from(vals), title };
}

/** Largeur de la bande GPU : N arrondi au multiple de 16 texels (RGBA32F : lignes de 256 octets, alignement WebGPU). */
export const atlasWidth = (n: number): number => Math.ceil(n / 16) * 16;

/**
 * Bande 2D pour le GPU : largeur `atlasWidth(N)`, hauteur N², texel (r, g + b·N) en RGBA32F (alpha = 1).
 * Les colonnes ≥ N sont du remplissage.
 */
export function lutToAtlas(lut: Lut3D): Float32Array {
  const n = lut.size, w = atlasWidth(n), out = new Float32Array(w * n * n * 4);
  for (let i = 0; i < n ** 3; i++) {
    // i = r + n·g + n²·b : ligne (g + n·b) = floor(i / n), colonne r = i mod n
    const row = Math.floor(i / n), col = i % n, o = (row * w + col) * 4;
    out[o] = lut.data[i * 3];
    out[o + 1] = lut.data[i * 3 + 1];
    out[o + 2] = lut.data[i * 3 + 2];
    out[o + 3] = 1;
  }
  return out;
}

/** Application CPU (interpolation trilinéaire) : référence pour les tests, miroir du WGSL. */
export function applyLut(lut: Lut3D, rgb: [number, number, number]): [number, number, number] {
  const n = lut.size, m = n - 1;
  const p = rgb.map((v) => Math.min(Math.max(v, 0), 1) * m);
  const i0 = p.map((v) => Math.min(Math.floor(v), m - 1)), f = p.map((v, k) => v - i0[k]);
  const at = (r: number, g: number, b: number, ch: number) => lut.data[(r + n * g + n * n * b) * 3 + ch];
  const out: number[] = [];
  for (let ch = 0; ch < 3; ch++) {
    let acc = 0;
    for (let dr = 0; dr < 2; dr++) for (let dg = 0; dg < 2; dg++) for (let db = 0; db < 2; db++) {
      const w = (dr ? f[0] : 1 - f[0]) * (dg ? f[1] : 1 - f[1]) * (db ? f[2] : 1 - f[2]);
      acc += w * at(i0[0] + dr, i0[1] + dg, i0[2] + db, ch);
    }
    out.push(acc);
  }
  return out as [number, number, number];
}
