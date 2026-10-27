// Plan de tournage : pistes caméra (position, pan / tilt / roll), mise au point et zoom, en secondes.
//
// Espaces de valeurs des pistes (ce sont eux qui sont interpolés) :
//  - x, y, z : unités de scène ; pan, tilt, roll : degrés (pan = lacet, tilt = tangage).
//  - focus : DIOPTRIES (1/m). Une bague de map est à peu près linéaire en 1/d : l'interpolation
//    donne un rack focus naturel et ∞ vaut 0.
//  - zoom : ln(focale en mm). Un zoom est perçu en rapport de focales, donc linéaire en log.

import { evaluate, newTrack, type Track } from './track';

export const TRACK_IDS = ['x', 'y', 'z', 'pan', 'tilt', 'roll', 'focus', 'zoom'] as const;
export type TrackId = (typeof TRACK_IDS)[number];

export const CAMERA_TRACKS: readonly TrackId[] = ['x', 'y', 'z', 'pan', 'tilt', 'roll'];

export interface Shot {
  /** Durée du plan, secondes. */
  duration: number;
  loop: boolean;
  tracks: Record<TrackId, Track>;
}

export function newShot(duration = 5): Shot {
  const tracks = {} as Record<TrackId, Track>;
  for (const id of TRACK_IDS) tracks[id] = newTrack();
  return { duration, loop: false, tracks };
}

/** Valeur de chaque piste qui a au moins une clé, au temps t. */
export function sampleShot(shot: Shot, t: number): Partial<Record<TrackId, number>> {
  const out: Partial<Record<TrackId, number>> = {};
  for (const id of TRACK_IDS) {
    const v = evaluate(shot.tracks[id], t);
    if (v !== undefined) out[id] = v;
  }
  return out;
}

/** Distance la plus proche de la bague de map (m) et plus loin « infini » représenté (m). */
export const FOCUS_MIN_M = 0.25;
export const FOCUS_FAR_M = 1000;

export const dioptersFromMeters = (m: number): number => 1 / Math.min(Math.max(m, FOCUS_MIN_M), FOCUS_FAR_M);
export const metersFromDiopters = (d: number): number => Math.min(Math.max(1 / Math.max(d, 1 / FOCUS_FAR_M), FOCUS_MIN_M), FOCUS_FAR_M);
export const zoomFromFocal = (mm: number): number => Math.log(mm);
export const focalFromZoom = (z: number): number => Math.exp(z);

/** Repères gravés sur la bague de map (m) ; Infinity = ∞. */
export const FOCUS_MARKS = [0.25, 0.3, 0.4, 0.5, 0.7, 1, 1.5, 2, 3, 5, 10, Infinity];

/** Lecture / lecture en boucle : avance `time` de `dt` secondes ; renvoie false si le plan est fini. */
export function advanceTime(time: number, dt: number, shot: Shot): { time: number; playing: boolean } {
  const t = time + dt;
  if (t < shot.duration) return { time: t, playing: true };
  if (shot.loop) return { time: shot.duration > 0 ? t % shot.duration : 0, playing: true };
  return { time: shot.duration, playing: false };
}
