// Effets de flare (maths pures, miroir des passes WGSL de render/post.ts) : étoile de diffraction du
// diaphragme, streaks anamorphiques, ghosts (reflets internes), lens dirt procédural.

/** Pointes de l'étoile quand l'objectif est circulaire (aucune lame) : croix de filtre « étoile ». */
export const STAR_FALLBACK_SPIKES = 6;

/**
 * Nombre de pointes de l'étoile de diffraction d'un diaphragme à `blades` lames : chaque côté du polygone
 * diffracte perpendiculairement à lui-même. Nombre pair de lames : les côtés opposés donnent la même
 * droite, donc N pointes ; nombre impair : 2N pointes. `override` > 0 impose le nombre de pointes.
 */
export function starSpikeCount(blades: number, override = 0): number {
  if (override > 0) return Math.round(override);
  if (blades < 3) return STAR_FALLBACK_SPIKES;
  return blades % 2 === 0 ? blades : 2 * blades;
}

/**
 * Angle (rad, sens trigonométrique, y vers le haut) de la première pointe ; les suivantes sont espacées de
 * 2π/count. Le polygone a un sommet en haut à rotation 0 (voir aperture.ts), donc les normales aux côtés sont
 * à π/2 + π/N + k·2π/N. Sans lames : une pointe horizontale.
 */
export function starFirstAngle(blades: number, rotationDeg: number): number {
  const rot = (rotationDeg * Math.PI) / 180;
  if (blades < 3) return rot;
  return rot + Math.PI / 2 + Math.PI / blades;
}

/** Angles des pointes (rad), pour les tests et l'aperçu. */
export function starAngles(blades: number, rotationDeg: number, override = 0): number[] {
  const n = starSpikeCount(blades, override);
  const a0 = starFirstAngle(blades, rotationDeg);
  return Array.from({ length: n }, (_, k) => a0 + (k * 2 * Math.PI) / n);
}

/**
 * Poids d'une prise à la fraction `t` ∈ [0,1] de la longueur d'une pointe : décroissance en (1 − t)²
 * (la figure de diffraction décroît vite puis traîne). Les poids de la boucle WGSL sont normalisés par leur somme.
 */
export function starWeight(t: number): number {
  const u = 1 - Math.min(Math.max(t, 0), 1);
  return u * u;
}

/** Part de l'étage supérieur reprise à chaque niveau de la montée du streak : longueur 0..1 → 0,5..0,92. */
export function streakMix(length: number): number {
  return 0.5 + 0.42 * Math.min(Math.max(length, 0), 1);
}

/** Un reflet interne : échelle autour du centre du cadre (négative = image inversée), rayon et teinte. */
export interface Ghost {
  /** Le reflet d'une source en p tombe en c + scale·(p − c). */
  scale: number;
  /** Rayon du disque du reflet, en fraction de la hauteur du cadre. */
  radius: number;
  tint: [number, number, number];
}

/** Six reflets, du plus proche du centre au plus lointain ; la teinte vient des traitements antireflets. */
export const GHOSTS: readonly Ghost[] = [
  { scale: -0.45, radius: 0.035, tint: [1.0, 0.55, 0.25] },
  { scale: -1.15, radius: 0.06, tint: [0.35, 0.75, 1.0] },
  { scale: 0.55, radius: 0.028, tint: [0.45, 1.0, 0.55] },
  { scale: 1.4, radius: 0.085, tint: [1.0, 0.45, 0.8] },
  { scale: -0.8, radius: 0.045, tint: [0.6, 0.6, 1.0] },
  { scale: 0.25, radius: 0.02, tint: [1.0, 0.9, 0.4] },
];

/** Position (coordonnées de cadre, centre = 0) du reflet `g` d'une source en `p`. */
export function ghostPosition(p: [number, number], g: Ghost): [number, number] {
  return [p[0] * g.scale, p[1] * g.scale];
}

/** Position source dont le reflet `g` tombe en `q` (inverse de `ghostPosition`) : celle que lit le shader. */
export function ghostSource(q: [number, number], g: Ghost): [number, number] {
  return [q[0] / g.scale, q[1] / g.scale];
}

// --- Lens dirt procédural ---

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/**
 * Masque de saleté d'objectif `size`×`size` (valeurs 0..255, un octet par texel) : traînées grasses (bruit
 * basse fréquence seuillé) + poussières et taches rondes de rayons variés. Déterministe selon `seed`.
 */
export function generateDirt(size: number, seed = 1): Uint8Array {
  const out = new Float32Array(size * size);
  // Traînées : trois octaves de bruit, seuillées pour ne garder que des plages irrégulières.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const n = 0.55 * valueNoise(u * 5, v * 5, seed) + 0.3 * valueNoise(u * 11, v * 11, seed + 1) + 0.15 * valueNoise(u * 23, v * 23, seed + 2);
      const t = Math.min(Math.max((n - 0.58) / 0.22, 0), 1);
      out[y * size + x] = 0.35 * t * t * (3 - 2 * t);
    }
  }
  // Grains : disques à bord doux, centres et rayons tirés de la graine.
  const count = Math.round(size * 0.9);
  for (let i = 0; i < count; i++) {
    const cx = hash2(i, 1, seed + 10) * size, cy = hash2(i, 2, seed + 10) * size;
    const big = hash2(i, 3, seed + 10);
    const r = size * (0.003 + 0.02 * big * big * big);
    const amp = 0.4 + 0.6 * hash2(i, 4, seed + 10);
    const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(size - 1, Math.ceil(cx + r + 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(size - 1, Math.ceil(cy + r + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (d >= 1) continue;
        const k = amp * (1 - d * d) * (1 - d * d);
        if (k > out[y * size + x]) out[y * size + x] = k;
      }
    }
  }
  const bytes = new Uint8Array(size * size);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.min(Math.max(out[i], 0), 1) * 255);
  return bytes;
}
