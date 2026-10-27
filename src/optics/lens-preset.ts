// Presets d'objectif (JSON) : un preset règle focale, ouverture, forme du bokeh et shift d'un coup.
// Les champs absents reprennent la valeur neutre (aperture = DEFAULT_APERTURE, shift et tilt = 0).

import { DEFAULT_APERTURE, type ApertureShape } from './aperture';
import lensesJson from '../presets/lenses.json';

export interface LensPreset {
  id: string;
  name: string;
  focalMm: number;
  fNumber: number;
  shiftMm?: { x: number; y: number };
  /** Tilt / swing (°) : x = swing (plan plus proche à droite si > 0), y = tilt (plus proche en bas si > 0). */
  tiltDeg?: { x: number; y: number };
  aperture: Partial<ApertureShape>;
}

export const LENS_PRESETS: LensPreset[] = lensesJson as LensPreset[];

export function getPreset(id: string): LensPreset | undefined {
  return LENS_PRESETS.find((p) => p.id === id);
}

/** Forme d'ouverture complète d'un preset (champs absents = neutres). */
export function presetAperture(p: LensPreset): ApertureShape {
  return { ...DEFAULT_APERTURE, ...p.aperture };
}
