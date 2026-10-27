// Piste d'animation : liste de clés triées par temps, évaluée par morceaux (curve.ts).

import { autoHandle, evalSegment, newKey, type Key } from './curve';

export interface Track { keys: Key[] }

export const newTrack = (): Track => ({ keys: [] });

/** Écart de temps (s) en dessous duquel deux clés sont la même. */
export const KEY_EPS = 1e-3;

export function refreshAuto(track: Track): void {
  track.keys.forEach((_, i) => autoHandle(track.keys, i));
}

/** Pose une clé à t (met à jour celle qui existe déjà à ce temps). Renvoie son index. */
export function setKey(track: Track, t: number, v: number): number {
  const { keys } = track;
  let i = keys.findIndex((k) => Math.abs(k.t - t) < KEY_EPS);
  if (i >= 0) keys[i].v = v;
  else {
    i = keys.findIndex((k) => k.t > t);
    if (i < 0) i = keys.length;
    keys.splice(i, 0, newKey(t, v));
  }
  refreshAuto(track);
  return i;
}

export function removeKey(track: Track, i: number): void {
  track.keys.splice(i, 1);
  refreshAuto(track);
}

/** Déplace la clé i à (t, v) en gardant l'ordre ; ne dépasse pas ses voisines. Renvoie l'index (inchangé). */
export function moveKey(track: Track, i: number, t: number, v: number): number {
  const { keys } = track;
  const lo = i > 0 ? keys[i - 1].t + KEY_EPS : -Infinity;
  const hi = i < keys.length - 1 ? keys[i + 1].t - KEY_EPS : Infinity;
  keys[i].t = Math.min(Math.max(t, lo), hi);
  keys[i].v = v;
  refreshAuto(track);
  return i;
}

/** Valeur de la piste à t ; tenue avant la première clé et après la dernière ; undefined si la piste est vide. */
export function evaluate(track: Track, t: number): number | undefined {
  const { keys } = track;
  if (!keys.length) return undefined;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (keys[i + 1].t < t) i++;
  return evalSegment(keys[i], keys[i + 1], t);
}

/**
 * Allège une piste enregistrée à la main (Douglas-Peucker sur (t, v)) : garde les clés dont la
 * suppression ferait dévier la courbe linéaire de plus de `tol` (unité de la valeur).
 */
export function thin(track: Track, tol: number): void {
  const { keys } = track;
  if (keys.length < 3) return;
  const keep = new Array<boolean>(keys.length).fill(false);
  keep[0] = keep[keys.length - 1] = true;
  const rec = (a: number, b: number) => {
    let worst = -1, dmax = tol;
    for (let i = a + 1; i < b; i++) {
      const f = (keys[i].t - keys[a].t) / (keys[b].t - keys[a].t);
      const d = Math.abs(keys[i].v - (keys[a].v + f * (keys[b].v - keys[a].v)));
      if (d > dmax) { dmax = d; worst = i; }
    }
    if (worst >= 0) { keep[worst] = true; rec(a, worst); rec(worst, b); }
  };
  rec(0, keys.length - 1);
  track.keys = keys.filter((_, i) => keep[i]);
  refreshAuto(track);
}
