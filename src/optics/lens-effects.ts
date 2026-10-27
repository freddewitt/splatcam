// Défauts et rendus optiques simples (maths pures, miroir des passes WGSL de render/post.ts) :
// vignettage naturel, distorsion radiale, bruit capteur, courbes de tone mapping.

/** Vignettage naturel en cos⁴θ : `tan2` = tan²θ de l'angle de champ du point. cos⁴θ = 1 / (1 + tan²θ)². */
export function naturalVignette(tan2: number): number {
  const c2 = 1 / (1 + tan2);
  return c2 * c2;
}

/**
 * Facteur radial de la distorsion (modèle de Brown, 2 termes). `r2` = r² avec r normalisé à 1 dans
 * un coin du cadre. L'image de sortie au rayon r lit la source au rayon r · factor :
 * k1 > 0 = barillet (les bords rentrent), k1 < 0 = coussinet.
 */
export function distortionFactor(r2: number, k1: number, k2 = 0): number {
  return 1 + k1 * r2 + k2 * r2 * r2;
}

/**
 * Division qui garde le coin de la sortie sur le coin de la source en barillet (le cadre reste plein :
 * sinon les coins liraient hors de l'image). Sans effet en coussinet (les coins restent à leur place,
 * les milieux de côté lisent au bord).
 */
export function distortionFit(k1: number, k2 = 0): number {
  return Math.max(1, 1 + k1 + k2);
}

/** Position source (coordonnées de cadre centrées, coin = 1) lue par le pixel de sortie `p`. */
export function distortSource(p: [number, number], k1: number, k2 = 0): [number, number] {
  const f = distortionFactor(p[0] * p[0] + p[1] * p[1], k1, k2) / distortionFit(k1, k2);
  return [p[0] * f, p[1] * f];
}

/**
 * Écart-type du bruit capteur (scene-linear) pour un signal `c` et une sensibilité `iso` :
 * bruit de photons (∝ √signal) plus bruit de lecture (plancher), ×√(ISO/800).
 * À ISO 800 et gris moyen (0,18) : ≈ 3 % ; ISO 6400 : ≈ 8,5 %.
 */
export function sensorNoiseSigma(c: number, iso: number): number {
  if (iso <= 0) return 0;
  return 0.03 * Math.sqrt(iso / 800) * Math.sqrt(0.18 * (Math.max(c, 0) + 0.01));
}

/** Courbe de Reinhard : c / (1 + c). */
export const reinhard = (c: number): number => c / (1 + c);

/** Approximation ACES de Narkowicz (gris moyen 0,18 → 0,27 ; blanc → ~0,8 à c = 1). */
export function acesFilm(c: number): number {
  const v = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  return Math.min(Math.max(v, 0), 1);
}
