// Émulsions : modèle de pellicule paramétrique appliqué à la lumière scène (linéaire).
//
// Une émulsion = trois courbes caractéristiques (une par couche : rouge, vert, bleu) puis des
// retouches de couleur qui ne se font pas par courbes :
//  1. courbe par canal, en diaphragmes (stops) autour du gris moyen 0,18 :
//       s = log2(x / 0,18) + décalage ;  f(s) = 1 / (1 + e^(−s·k(s))) ;  y = noir + (blanc − noir)·f
//     k = contraste au milieu ; k(s) passe de k·pied (ombres) à k·épaule (hautes lumières) : pied et
//     épaule < 1 = ombres bouchées / hautes lumières fondues plus doucement. noir > 0 = noirs relevés
//     (mat), blanc < 1 = hautes lumières qui n'atteignent pas le blanc.
//  2. monochrome éventuel (pondération spectrale des canaux : filtre coloré devant une pellicule N&B) ;
//  3. désaturation vers le blanc et vers le noir (les trois couches de colorant s'épuisent ensemble) ;
//  4. teinte par secteur (R J V C B M) : saturation, rotation, luminance, en HSV ; saturation globale ;
//  5. dominantes des ombres et des hautes lumières (split toning).
// Les valeurs des préréglages sont des créations originales, INSPIRÉES des familles de pellicules
// (saturation d'une diapo, teal des ombres d'un négatif ciné…), pas des mesures des émulsions réelles.
// Idée de structure empruntée à soup-engine (GPL v2) ; aucune donnée ni aucun code n'en est repris.
// Le shader `render/post.ts` doit rester aligné sur `filmLook` (testé).

import stocksJson from '../presets/stocks.json';

export interface ChannelCurve {
  /** Décalage d'exposition (diaphragmes), s'ajoute au décalage global. */
  shift?: number;
  /** Facteur sur le contraste global. */
  contrast?: number;
  /** Ajout au noir / au blanc global. */
  black?: number;
  white?: number;
}

export interface FilmStock {
  id: string;
  name: string;
  description: string;
  curve: { contrast: number; toe: number; shoulder: number; shift: number; black: number; white: number };
  channels?: { r?: ChannelCurve; g?: ChannelCurve; b?: ChannelCurve };
  /** Saturation globale (1 = inchangée) et désaturation vers blanc / noir (0 à 1). */
  saturation: number;
  chromaRolloff: number;
  /** Par secteur de teinte, ordre R, J, V, C, B, M : saturation (×), rotation (°), luminance (×). */
  hueSat?: number[];
  hueRot?: number[];
  hueLum?: number[];
  /** Dominantes ajoutées (valeurs affichées), pondérées par (1 − luma) pour les ombres et luma pour les hautes lumières. */
  splitShadow?: number[];
  splitHighlight?: number[];
  /** Poids R, V, B du monochrome (absent = couleur). */
  mono?: number[];
  /** Valeurs proposées pour les réglages de halation et de grain quand on choisit l'émulsion. */
  halation?: { amount: number; threshold: number; tint: number[] };
  grain?: { amount: number; size: number };
}

export const FILM_STOCKS: FilmStock[] = stocksJson as FilmStock[];
export const getStock = (id: string): FilmStock | undefined => FILM_STOCKS.find((s) => s.id === id);

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

export interface ChannelParams { k: number; shift: number; black: number; white: number }

/** Paramètres de courbe de chaque canal (global + écarts du canal). */
export function channelParams(stock: FilmStock): [ChannelParams, ChannelParams, ChannelParams] {
  const c = stock.curve;
  return (['r', 'g', 'b'] as const).map((ch) => {
    const d = stock.channels?.[ch] ?? {};
    return { k: c.contrast * (d.contrast ?? 1), shift: c.shift + (d.shift ?? 0), black: c.black + (d.black ?? 0), white: c.white + (d.white ?? 0) };
  }) as [ChannelParams, ChannelParams, ChannelParams];
}

/** Courbe caractéristique d'un canal : valeur linéaire de scène → valeur affichée (0 à 1). */
export function filmCurve(x: number, p: ChannelParams, toe: number, shoulder: number): number {
  const s = Math.log2(Math.max(x, 1e-6) / 0.18) + p.shift;
  const k = p.k * (toe + (shoulder - toe) * smoothstep(-1.5, 1.5, s));
  return p.black + (p.white - p.black) / (1 + Math.exp(-s * k));
}

export type Vec3 = [number, number, number];

export function rgbToHsv([r, g, b]: Vec3): Vec3 {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-9) {
    if (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return [h / 6, mx > 1e-9 ? d / mx : 0, mx];
}

export function hsvToRgb([h, s, v]: Vec3): Vec3 {
  const f = (n: number) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(Math.min(k, 4 - k, 1), 0); };
  return [f(5), f(3), f(1)];
}

/** Interpolation entre secteurs R J V C B M (centres tous les 60°) pour la teinte h ∈ [0, 1). */
export function sectorValue(list: number[], h: number): number {
  const h6 = ((h % 1) + 1) % 1 * 6, i = Math.floor(h6), f = h6 - i;
  const t = f * f * (3 - 2 * f);
  return list[i % 6] + (list[(i + 1) % 6] - list[i % 6]) * t;
}

const luma = ([r, g, b]: Vec3): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Rendu complet de l'émulsion : lumière scène linéaire → valeur affichée (0 à 1). Miroir du shader. */
export function filmLook(rgb: Vec3, stock: FilmStock): Vec3 {
  const cp = channelParams(stock), { toe, shoulder } = stock.curve;
  let c: Vec3 = [filmCurve(rgb[0], cp[0], toe, shoulder), filmCurve(rgb[1], cp[1], toe, shoulder), filmCurve(rgb[2], cp[2], toe, shoulder)];
  if (stock.mono) { const g = c[0] * stock.mono[0] + c[1] * stock.mono[1] + c[2] * stock.mono[2]; c = [g, g, g]; }
  const l = luma(c);
  const roll = stock.chromaRolloff * (smoothstep(0.78, 1, l) * 0.6 + (1 - smoothstep(0, 0.1, l)) * 0.4);
  c = c.map((v) => l + (v - l) * (1 - roll)) as Vec3;
  const hsv = rgbToHsv(c);
  const sat = stock.hueSat ?? [1, 1, 1, 1, 1, 1], rot = stock.hueRot ?? [0, 0, 0, 0, 0, 0], lum = stock.hueLum ?? [1, 1, 1, 1, 1, 1];
  const h = hsv[0];
  hsv[0] = (((h + sectorValue(rot, h) / 360) % 1) + 1) % 1;
  const chroma = hsv[1];
  hsv[1] = Math.min(Math.max(hsv[1] * stock.saturation * sectorValue(sat, h), 0), 1);
  // Luminance par teinte pondérée par la saturation : un gris n'a pas de teinte, il ne doit pas être éclairci.
  hsv[2] *= 1 + (sectorValue(lum, h) - 1) * chroma;
  c = hsvToRgb(hsv);
  const ls = luma(c), sh = stock.splitShadow ?? [0, 0, 0], hi = stock.splitHighlight ?? [0, 0, 0];
  return c.map((v, i) => Math.min(Math.max(v + sh[i] * (1 - ls) * (1 - ls) + hi[i] * ls * ls, 0), 1)) as Vec3;
}

export interface StockUniforms {
  cv0: number[]; cv1: number[]; cv2: number[]; cv3: number[];
  satA: number[]; satB: number[]; rotA: number[]; rotB: number[]; lumA: number[]; lumB: number[];
  splitS: number[]; splitH: number[]; mono: number[];
}

/**
 * Paramètres de l'émulsion rangés pour le shader (vec4 par groupe). splitH.w = 1 : émulsion active ;
 * mono.w = 1 : monochrome. Sans émulsion (null) tout est neutre et inactif.
 */
export function stockUniforms(stock: FilmStock | null): StockUniforms {
  if (!stock) {
    const z = [0, 0, 0, 0], one = [1, 1, 1, 1];
    return { cv0: [0.6, 0.6, 0.6, 1], cv1: [0, 0, 0, 1], cv2: [0, 0, 0, 0], cv3: [1, 1, 1, 1], satA: one, satB: one, rotA: z, rotB: z, lumA: one, lumB: one, splitS: z, splitH: z, mono: z };
  }
  const [r, g, b] = channelParams(stock);
  const six = (l: number[] | undefined, d: number): [number[], number[]] => {
    const v = l ?? [d, d, d, d, d, d];
    return [v.slice(0, 4), [v[4], v[5], 0, 0]];
  };
  const [satA, satB] = six(stock.hueSat, 1), [rotA, rotB] = six(stock.hueRot, 0), [lumA, lumB] = six(stock.hueLum, 1);
  const ss = stock.splitShadow ?? [0, 0, 0], sh = stock.splitHighlight ?? [0, 0, 0], mono = stock.mono ?? [0, 0, 0];
  return {
    cv0: [r.k, g.k, b.k, stock.curve.toe],
    cv1: [r.shift, g.shift, b.shift, stock.curve.shoulder],
    cv2: [r.black, g.black, b.black, stock.chromaRolloff],
    cv3: [r.white, g.white, b.white, stock.saturation],
    satA, satB, rotA, rotB, lumA, lumB,
    splitS: [ss[0], ss[1], ss[2], 0], splitH: [sh[0], sh[1], sh[2], 1],
    mono: [mono[0], mono[1], mono[2], stock.mono ? 1 : 0],
  };
}
