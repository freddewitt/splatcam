// Ouverture « programmable » : tout le caractère du bokeh vient de la distribution des échantillons.
//
// Deux niveaux, dont le second est dupliqué en WGSL (src/render/dof-renderer.ts) :
//  1. Échantillonnage CPU (`ApertureSampler`) : Halton projeté sur le disque unité avec une densité
//     radiale (aberration sphérique, anneaux) tirée par inversion de la CDF. Symétrique en rotation,
//     donc compatible avec tout ce qui suit. Squeeze anamorphique appliqué sur le décalage de caméra.
//  2. Masque par pixel (`apertureMask`) : l'ouverture effective dépend de la position dans le champ
//     (cat-eye = vignettage mécanique, swirl = rotation du repère avec le rayon image). Un échantillon
//     est donc accepté ou rejeté PAR PIXEL ; l'accumulateur garde la somme des poids (alpha).
//
// Repère : `u` = décalage normalisé dans le disque unité (x = droite caméra, y = haut caméra).
// `f` = position dans le champ, normalisée par la demi-diagonale du cadre : |f| = ρ, 1 dans un coin.

import { halton } from './sampling';

export interface ApertureShape {
  /** Nombre de lames ; < 3 = ouverture circulaire. */
  blades: number;
  /** Arrondi des lames : 0 = côtés droits, 1 = cercle. */
  roundness: number;
  /** Rotation du polygone, degrés (sommet vers le haut à 0). */
  rotationDeg: number;
  /** Squeeze anamorphique : 1 = sphérique, 2 = anamorphique 2x (bokeh ovale haut). */
  squeeze: number;
  /** Aberration sphérique, −1 (centre dense, bords doux) à +1 (bord appuyé, « bulle de savon »). */
  sphericalAberration: number;
  /** Anneaux (onion rings) : profondeur de modulation 0..1 et nombre d'anneaux sur le rayon. */
  rings: number;
  ringCount: number;
  /** Cat-eye (vignettage mécanique), 0..1 : ouverture en citron dans les coins. */
  catEye: number;
  /** Swirl : rotation du repère (lames, citron) en bordure de champ, degrés. */
  swirlDeg: number;
}

export const DEFAULT_APERTURE: ApertureShape = {
  blades: 0, roundness: 1, rotationDeg: 0, squeeze: 1,
  sphericalAberration: 0, rings: 0, ringCount: 12,
  catEye: 0, swirlDeg: 0,
};

/** Poids radial w(r), r ∈ [0,1] : aberration sphérique × anneaux. Densité d'échantillons par unité d'AIRE. */
export function radialWeight(r: number, s: ApertureShape): number {
  const sa = 1 + s.sphericalAberration * (2 * r - 1); // −1 → 2−2r, +1 → 2r
  const ring = 1 - 0.5 * s.rings * (1 - Math.cos(2 * Math.PI * s.ringCount * r));
  return Math.max(0, sa * ring);
}

const TABLE = 2048;

/**
 * Échantillons d'ouverture déterministes : l'échantillon `i` est toujours le même (export reproductible).
 * L'échantillon 0 est au centre de l'ouverture (image « sténopé », accepté par tous les masques).
 */
export class ApertureSampler {
  private readonly invCdf: Float64Array | null;

  constructor(private readonly shape: ApertureShape) {
    const flat = shape.sphericalAberration === 0 && shape.rings === 0;
    if (flat) { this.invCdf = null; return; }
    // CDF de r : densité ∝ w(r)·r (élément d'aire 2πr dr), puis table d'inversion.
    const cdf = new Float64Array(TABLE + 1);
    for (let k = 1; k <= TABLE; k++) {
      const r = (k - 0.5) / TABLE;
      cdf[k] = cdf[k - 1] + radialWeight(r, shape) * r;
    }
    const total = cdf[TABLE] || 1;
    const inv = new Float64Array(TABLE + 1);
    let k = 0;
    for (let j = 0; j <= TABLE; j++) {
      const target = (j / TABLE) * total;
      while (k < TABLE && cdf[k + 1] < target) k++;
      const span = cdf[k + 1] - cdf[k] || 1;
      inv[j] = (k + Math.min(1, Math.max(0, (target - cdf[k]) / span))) / TABLE;
    }
    this.invCdf = inv;
  }

  private radius(u: number): number {
    if (!this.invCdf) return Math.sqrt(u); // uniforme en aire
    const x = u * TABLE, j = Math.min(TABLE - 1, Math.floor(x));
    return this.invCdf[j] + (this.invCdf[j + 1] - this.invCdf[j]) * (x - j);
  }

  /** Échantillon `i` (≥ 0) dans le disque unité : [ux, uy]. */
  sample(i: number): [number, number] {
    const r = this.radius(halton(i, 2)), a = 2 * Math.PI * halton(i, 3);
    return [r * Math.cos(a), r * Math.sin(a)];
  }

  /** Décalage de caméra dans le plan de l'objectif pour l'échantillon `i`, en multiples du rayon d'ouverture. */
  offset(i: number): [number, number] {
    const [x, y] = this.sample(i);
    return [x / this.shape.squeeze, y]; // anamorphique : distribution comprimée en x
  }
}

/** Rayon de la frontière d'un polygone régulier de `n` côtés (circonrayon 1, sommet en haut) dans la direction `angle` (rad), arrondi par `roundness`. */
export function bladeBoundary(angle: number, n: number, roundness: number): number {
  if (n < 3) return 1;
  const wedge = (2 * Math.PI) / n;
  // Angle à l'intérieur du secteur, ramené à [−π/n, π/n] autour d'un sommet (sommet vers +y = angle π/2).
  const a = ((((angle - Math.PI / 2) % wedge) + wedge * 1.5) % wedge) - wedge / 2;
  const flat = Math.cos(Math.PI / n) / Math.cos(wedge / 2 - Math.abs(a)); // côté droit (angle compté depuis le milieu du côté)
  return flat + (1 - flat) * roundness; // 1 = cercle de circonrayon
}

/**
 * Masque d'ouverture au pixel de champ `f` pour le décalage normalisé `u` (avant squeeze).
 * Miroir CPU du shader d'accumulation : toute modification se fait dans les deux.
 */
export function apertureMask(u: [number, number], f: [number, number], s: ApertureShape): boolean {
  const rho = Math.min(1, Math.hypot(f[0], f[1]));
  // Swirl : on exprime u dans un repère tourné de φ(ρ) = swirl·ρ².
  const phi = ((s.swirlDeg * Math.PI) / 180) * rho * rho;
  const c = Math.cos(phi), sn = Math.sin(phi);
  const wx = c * u[0] + sn * u[1], wy = -sn * u[0] + c * u[1];
  // Lames : polygone tourné de rotationDeg.
  if (s.blades >= 3) {
    const rot = (s.rotationDeg * Math.PI) / 180;
    const ang = Math.atan2(wy, wx) - rot;
    if (Math.hypot(wx, wy) > bladeBoundary(ang, s.blades, s.roundness)) return false;
  } else if (Math.hypot(wx, wy) > 1) return false;
  // Cat-eye : intersection de deux disques unité décentrés de ±d/2 le long de la direction du champ.
  if (s.catEye > 0 && rho > 1e-6) {
    const d = 1.6 * s.catEye * rho * rho;
    const fx = f[0] / rho, fy = f[1] / rho;
    const along = wx * fx + wy * fy, across = -wx * fy + wy * fx;
    if (Math.hypot(along - d / 2, across) > 1 || Math.hypot(along + d / 2, across) > 1) return false;
  }
  return true;
}
