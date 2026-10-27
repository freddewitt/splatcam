// Étalonnage (correction colorimétrique), en deux temps :
// 1. Balance des blancs (température / teinte) sur l'image SCÈNE-LINÉAIRE, avant émulsion ou tone mapping,
//    comme les gains R V B d'une caméra. Luminance conservée : seule la couleur change.
// 2. Lift / gamma / gain (avec une couleur chacun), contraste et saturation sur l'image AFFICHÉE (sRGB 0..1),
//    juste avant le look (LUT) : l'étalonnage « nourrit » la LUT, comme dans un logiciel d'étalonnage.
// Le shader de composition (render/post.ts) est le miroir exact de ces fonctions.

import { hsvToRgb } from './film-stock';

export type Vec3 = [number, number, number];

export const LUMA: Vec3 = [0.2126, 0.7152, 0.0722];
/** Pivot du contraste : gris moyen 18 % encodé sRGB (≈ 0,461). */
export const CONTRAST_PIVOT = 0.461;

export interface GradeParams {
  /** Température : −1 (froid, bleu) à +1 (chaud, orangé). ±1 = ±1 diaphragme d'écart entre rouge et bleu. */
  gradeTemp: number;
  /** Teinte : −1 (vert) à +1 (magenta). */
  gradeTint: number;
  /** Contraste autour du gris moyen (1 = neutre). */
  gradeContrast: number;
  /** Saturation (0 = noir et blanc, 1 = neutre). */
  gradeSaturation: number;
  /** Lift (noirs) : décalage du noir, −0,25 à +0,25 ; couleur : teinte (degrés) et force 0..1. */
  gradeLift: number;
  gradeLiftHue: number;
  gradeLiftColor: number;
  /** Gamma (médiums) en diaphragmes : > 0 éclaircit les médiums, noir et blanc fixes. */
  gradeGamma: number;
  gradeGammaHue: number;
  gradeGammaColor: number;
  /** Gain (blancs) en diaphragmes : multiplie l'image, le noir reste fixe. */
  gradeGain: number;
  gradeGainHue: number;
  gradeGainColor: number;
}

export const DEFAULT_GRADE: GradeParams = {
  gradeTemp: 0, gradeTint: 0, gradeContrast: 1, gradeSaturation: 1,
  gradeLift: 0, gradeLiftHue: 200, gradeLiftColor: 0,
  gradeGamma: 0, gradeGammaHue: 40, gradeGammaColor: 0,
  gradeGain: 0, gradeGainHue: 40, gradeGainColor: 0,
};

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Gains R V B de balance des blancs, normalisés pour que la luminance d'un gris reste la même. */
export function whiteBalanceGains(temp: number, tint: number): Vec3 {
  const g: Vec3 = [2 ** (0.5 * temp), 2 ** (-0.5 * tint), 2 ** (-0.5 * temp)];
  const k = dot(g, LUMA);
  return [g[0] / k, g[1] / k, g[2] / k];
}

/** Direction de couleur d'une roue : teinte pure moins sa luminance (somme pondérée nulle), × force. */
export function hueOffset(hueDeg: number, amount: number): Vec3 {
  const c = hsvToRgb([(((hueDeg / 360) % 1) + 1) % 1, 1, 1]);
  const l = dot(c, LUMA);
  return [(c[0] - l) * amount, (c[1] - l) * amount, (c[2] - l) * amount];
}

export interface GradeCoefs {
  /** Gains de balance des blancs (scène-linéaire). */
  wb: Vec3;
  /** Valeur de sortie du noir, par canal. */
  lift: Vec3;
  /** Exposant des médiums par canal (sortie = entrée^(1/gamma)). */
  gamma: Vec3;
  /** Valeur de sortie du blanc, par canal. */
  gain: Vec3;
  contrast: number;
  saturation: number;
  /** false : réglages neutres, le shader saute l'étalonnage (sortie bit à bit identique à avant). */
  active: boolean;
}

export function gradeCoefs(p: GradeParams): GradeCoefs {
  const dl = hueOffset(p.gradeLiftHue, p.gradeLiftColor);
  const dg = hueOffset(p.gradeGammaHue, p.gradeGammaColor);
  const dk = hueOffset(p.gradeGainHue, p.gradeGainColor);
  const lift = dl.map((d) => p.gradeLift + 0.1 * d) as Vec3;
  const gamma = dg.map((d) => 2 ** (p.gradeGamma + 0.5 * d)) as Vec3;
  const gain = dk.map((d) => 2 ** (p.gradeGain + 0.5 * d)) as Vec3;
  const active = p.gradeTemp !== 0 || p.gradeTint !== 0 || p.gradeContrast !== 1 || p.gradeSaturation !== 1
    || p.gradeLift !== 0 || p.gradeLiftColor !== 0 || p.gradeGamma !== 0 || p.gradeGammaColor !== 0
    || p.gradeGain !== 0 || p.gradeGainColor !== 0;
  return { wb: whiteBalanceGains(p.gradeTemp, p.gradeTint), lift, gamma, gain, contrast: p.gradeContrast, saturation: p.gradeSaturation, active };
}

/**
 * Étalonnage de l'image affichée (sRGB 0..1), miroir de `grade()` dans le shader :
 *   y = gain·x + lift·(1 − x)        (le noir va à lift, le blanc à gain)
 *   y = y^(1/gamma)                  (médiums)
 *   y = pivot + (y − pivot)·contraste
 *   y = L + (y − L)·saturation       (L = luminance Rec.709)
 */
export function applyGrade(c: Vec3, k: GradeCoefs): Vec3 {
  let y = c.map((x, i) => {
    const v = Math.max(k.gain[i] * x + k.lift[i] * (1 - x), 0);
    return CONTRAST_PIVOT + (v ** (1 / k.gamma[i]) - CONTRAST_PIVOT) * k.contrast;
  }) as Vec3;
  const l = dot(y, LUMA);
  y = y.map((v) => Math.min(Math.max(l + (v - l) * k.saturation, 0), 1)) as Vec3;
  return y;
}
