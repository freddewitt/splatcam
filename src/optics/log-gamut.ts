// Courbes logarithmiques et gamuts Fujifilm (F-Log, F-Log2) pour alimenter les LUT d'origine du
// constructeur, qui attendent une image encodée en log dans le gamut de la caméra.
//
// Constantes et formules : spécification publique F-Log / F-Log2 (valeurs recoupées avec
// colour-science, `fujifilm_f_log.py`). Entrée : lumière scène linéaire en réflectance (0,18 = gris moyen),
// sortie : valeur normalisée 0 à 1 (0,18 → 0,4593 en F-Log, 0,3910 en F-Log2).
//   x < cut1 : e·x + f      sinon : c · log10(a·x + b) + d
// Gamuts : F-Gamut = primaires Rec.2020 ; F-Gamut C = primaires élargies (D65).

export type LogCurve = 'flog' | 'flog2';

interface LogConstants { cut1: number; cut2: number; a: number; b: number; c: number; d: number; e: number; f: number }

export const LOG_CONSTANTS: Record<LogCurve, LogConstants> = {
  flog: { cut1: 0.00089, cut2: 0.100537775223865, a: 0.555556, b: 0.009468, c: 0.344676, d: 0.790453, e: 8.735631, f: 0.092864 },
  flog2: { cut1: 0.000889, cut2: 0.100686685370811, a: 5.555556, b: 0.064829, c: 0.245281, d: 0.384316, e: 8.799461, f: 0.092864 },
};

/** Encodage F-Log / F-Log2 d'une valeur linéaire (réflectance). */
export function logEncode(x: number, curve: LogCurve): number {
  const k = LOG_CONSTANTS[curve];
  return x < k.cut1 ? k.e * x + k.f : k.c * Math.log10(k.a * x + k.b) + k.d;
}

/** Décodage inverse (pour les tests et les LUT de contrôle). */
export function logDecode(y: number, curve: LogCurve): number {
  const k = LOG_CONSTANTS[curve];
  return y < k.cut2 ? (y - k.f) / k.e : (Math.pow(10, (y - k.d) / k.c) - k.b) / k.a;
}

export type Mat3 = [number, number, number, number, number, number, number, number, number];
export type Chromaticity = [number, number];
export interface Primaries { r: Chromaticity; g: Chromaticity; b: Chromaticity; white: Chromaticity }

export const D65: Chromaticity = [0.3127, 0.329];
export const REC709: Primaries = { r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06], white: D65 };
export const REC2020: Primaries = { r: [0.708, 0.292], g: [0.17, 0.797], b: [0.131, 0.046], white: D65 };
export const F_GAMUT: Primaries = REC2020;
export const F_GAMUT_C: Primaries = { r: [0.7347, 0.2653], g: [0.0263, 0.9737], b: [0.1173, -0.0224], white: D65 };

const mul = (a: Mat3, b: Mat3): Mat3 => {
  const o = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o as Mat3;
};

export function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det) as Mat3;
}

/** Matrice RGB linéaire → XYZ d'un jeu de primaires (blanc normalisé à Y = 1). */
export function rgbToXyz(p: Primaries): Mat3 {
  const xyz = (c: Chromaticity): [number, number, number] => [c[0] / c[1], 1, (1 - c[0] - c[1]) / c[1]];
  const R = xyz(p.r), G = xyz(p.g), B = xyz(p.b), W = xyz(p.white);
  const m: Mat3 = [R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]];
  const inv = invert(m);
  const s = [0, 1, 2].map((i) => inv[i * 3] * W[0] + inv[i * 3 + 1] * W[1] + inv[i * 3 + 2] * W[2]);
  return [m[0] * s[0], m[1] * s[1], m[2] * s[2], m[3] * s[0], m[4] * s[1], m[5] * s[2], m[6] * s[0], m[7] * s[1], m[8] * s[2]];
}

/** Matrice de conversion d'un jeu de primaires vers un autre (RGB linéaire, même blanc). */
export function gamutMatrix(from: Primaries, to: Primaries): Mat3 {
  return mul(invert(rgbToXyz(to)), rgbToXyz(from));
}

/** Entrée attendue par une LUT : image affichée, ou scène encodée en log dans le gamut du constructeur. */
export type LutInput = 'display' | 'flog' | 'flog2' | 'flog2c';

export const LUT_INPUT_LABELS: Record<LutInput, string> = {
  display: 'Image affichée (sRGB)',
  flog: 'F-Log (F-Gamut)',
  flog2: 'F-Log2 (F-Gamut)',
  flog2c: 'F-Log2 C (F-Gamut C)',
};

/** Courbe et matrice (Rec.709 de la scène → gamut de la LUT) d'un mode d'entrée log ; null = affichage. */
export function lutInputSpec(input: LutInput): { curve: LogCurve; matrix: Mat3 } | null {
  switch (input) {
    case 'flog': return { curve: 'flog', matrix: gamutMatrix(REC709, F_GAMUT) };
    case 'flog2': return { curve: 'flog2', matrix: gamutMatrix(REC709, F_GAMUT) };
    case 'flog2c': return { curve: 'flog2', matrix: gamutMatrix(REC709, F_GAMUT_C) };
    default: return null;
  }
}
