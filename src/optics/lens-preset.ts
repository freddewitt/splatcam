// Presets d'objectif (JSON) : un preset règle focale, ouverture, forme du bokeh, shift / tilt ET les défauts
// propres à l'objectif (distorsion, vignettage, aberration chromatique, flares). Les champs absents reprennent la
// valeur neutre (aperture = DEFAULT_APERTURE, défauts optiques = DEFAULT_POST, shift et tilt = 0).
// Les objectifs nommés d'après des séries réelles sont des APPROXIMATIONS de leur caractère, pas des mesures.

import { DEFAULT_APERTURE, type ApertureShape } from './aperture';
import { DEFAULT_POST, type PostParams } from '../render/post';
import lensesJson from '../presets/lenses.json';

/** Réglages de post qui appartiennent à l'objectif (et non à la pellicule ou au capteur). */
export const LENS_POST_KEYS = [
  'distortion', 'vignetteOptical', 'chromaticAberration',
  'starburst', 'starburstLength', 'starburstSpikes',
  'streak', 'streakLength', 'streakTint', 'ghosts', 'ghostCount', 'flareThreshold',
] as const;
export type LensPostKey = typeof LENS_POST_KEYS[number];
export type LensPost = Partial<Pick<PostParams, LensPostKey>>;

export interface LensPreset {
  id: string;
  name: string;
  /** Famille affichée dans le menu (marque, type). */
  family: string;
  /** Une phrase sur le caractère de l'objectif. */
  description?: string;
  focalMm: number;
  fNumber: number;
  /** Ouverture maximale (nombre f / T le plus petit) de la série. */
  maxAperture?: number;
  /** Focales disponibles d'une série de focales fixes, mm. */
  focals?: number[];
  /** Plage d'un zoom, mm. */
  zoom?: { min: number; max: number };
  /** Distance minimale de mise au point, m. */
  minFocusM?: number;
  shiftMm?: { x: number; y: number };
  /** Tilt / swing (°) : x = swing (plan plus proche à droite si > 0), y = tilt (plus proche en bas si > 0). */
  tiltDeg?: { x: number; y: number };
  aperture: Partial<ApertureShape>;
  /** Défauts optiques de l'objectif (voir LENS_POST_KEYS). */
  post?: LensPost;
}

export const LENS_PRESETS: LensPreset[] = lensesJson as LensPreset[];

/** Familles dans l'ordre d'apparition du fichier. */
export const LENS_FAMILIES: string[] = [...new Set(LENS_PRESETS.map((p) => p.family))];

export function getPreset(id: string): LensPreset | undefined {
  return LENS_PRESETS.find((p) => p.id === id);
}

/** Forme d'ouverture complète d'un preset (champs absents = neutres). */
export function presetAperture(p: LensPreset): ApertureShape {
  return { ...DEFAULT_APERTURE, ...p.aperture };
}

/** Défauts optiques complets d'un preset : les clés d'objectif absentes reviennent au neutre (pas d'héritage du preset précédent). */
export function presetPost(p: LensPreset): LensPost {
  const out: Record<string, unknown> = {};
  for (const k of LENS_POST_KEYS) {
    const v = p.post?.[k] ?? DEFAULT_POST[k];
    out[k] = Array.isArray(v) ? [...v] : v;
  }
  return out as LensPost;
}

/** La focale `mm` appartient-elle à l'objectif (dans la plage du zoom, ou une focale de la série) ? */
export function presetHasFocal(p: LensPreset, mm: number): boolean {
  if (p.zoom) return mm >= p.zoom.min - 1e-6 && mm <= p.zoom.max + 1e-6;
  if (p.focals) return p.focals.some((f) => Math.abs(f - mm) < 0.05);
  return Math.abs(p.focalMm - mm) < 0.05;
}

/** Texte court des focales d'un preset : « 19–90 mm », « 12–150 mm (16 focales) » ou « 50 mm ». */
export function presetFocalLabel(p: LensPreset): string {
  if (p.zoom) return `zoom ${p.zoom.min}–${p.zoom.max} mm`;
  if (p.focals && p.focals.length > 1) return `${p.focals[0]}–${p.focals[p.focals.length - 1]} mm (${p.focals.length} focales)`;
  return `${p.focalMm} mm`;
}
