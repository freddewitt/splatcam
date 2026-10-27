// Obturateur et défauts de caméra : fenêtre d'exposition, rolling shutter, gate weave.
//
// Modèle d'exposition d'une image prise à l'instant t (début de l'ouverture de l'obturateur) :
//  - fenêtre d'exposition w = (angle / 360) / fps secondes ;
//  - rolling shutter : la ligne r (0 = haut, 1 = bas) est exposée sur [ρ·r, ρ·r + w] après t,
//    ρ = temps de lecture du capteur. Un sous-rendu d'instant u ∈ [0, ρ + w) ne contribue donc
//    qu'aux lignes qui « voient » u. Les instants sont tirés uniformément sur [0, ρ + w) : chaque
//    ligne en accepte la fraction w / (ρ + w), constante, qui sert à normaliser l'exposition.
// Toutes les durées sont en secondes.

import { halton } from './sampling';

/** Durée d'exposition (s) pour un angle d'obturateur en degrés (180° à 25 i/s = 1/50 s). */
export function shutterWindow(angleDeg: number, fps: number): number {
  return (Math.max(angleDeg, 0) / 360) / fps;
}

export interface ExposurePlan {
  /** Largeur effective de la fenêtre d'exposition d'une ligne (s). */
  window: number;
  /** Temps de lecture ρ (s). */
  readout: number;
  /** Étendue des instants tirés : ρ + window (s). */
  span: number;
  /** Fraction des sous-rendus acceptés par chaque ligne : window / span. */
  acceptance: number;
  /** true si au moins un des deux effets (flou de mouvement, rolling shutter) est actif. */
  active: boolean;
}

/**
 * Plan d'exposition. Avec un rolling shutter et un obturateur « instantané » (angle 0), la fenêtre
 * est portée à 10 % du temps de lecture pour qu'une ligne accepte des échantillons.
 */
export function exposurePlan(angleDeg: number, fps: number, readoutMs: number): ExposurePlan {
  const readout = Math.max(readoutMs, 0) / 1000;
  const raw = shutterWindow(angleDeg, fps);
  const window = readout > 0 ? Math.max(raw, readout * 0.1) : raw;
  const span = readout + window;
  return { window, readout, span, acceptance: span > 0 ? window / span : 1, active: span > 0 };
}

/** Instant (s après t) du sous-rendu i : Halton base 5, indépendant de l'ouverture (bases 2 et 3). */
export function sampleTime(i: number, plan: ExposurePlan): number {
  return plan.span * halton(i, 5);
}

/**
 * La ligne `row` (0 = haut, 1 = bas) accepte-t-elle le sous-rendu d'instant `u` ?
 * Miroir CPU du masque WGSL de l'accumulation (dof-renderer.ts) : garder les deux alignés.
 */
export function rowAccepts(u: number, row: number, plan: ExposurePlan): boolean {
  if (plan.readout <= 0) return true;
  const start = plan.readout * row;
  return u >= start && u < start + plan.window;
}

/** Bruit de valeur 1D lissé (déterministe) : valeur dans [−1, 1] au temps t (en « cases » de 1 s). */
export function valueNoise1D(t: number, seed: number): number {
  const hash = (n: number) => {
    const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const i = Math.floor(t), f = t - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

export interface GateWeave {
  /** Translation de l'image en NDC (1 = demi-hauteur / demi-largeur du cadre). */
  x: number;
  y: number;
  /** Rotation de l'image, degrés. */
  rollDeg: number;
}

/** Amplitudes à `amount` = 1 : 0,4 % de la hauteur du cadre en translation, 0,06° en rotation. */
export const WEAVE_TRANSLATION_NDC = 0.008;
export const WEAVE_ROLL_DEG = 0.06;
/** Fréquence typique du balancement du film dans le couloir (Hz). */
export const WEAVE_HZ = 2.5;

/** Oscillation du film dans le couloir à l'instant t (s) : bruit lissé, quelques Hz, translation + léger roulis. */
export function gateWeave(t: number, amount: number): GateWeave {
  const k = t * WEAVE_HZ;
  return {
    x: valueNoise1D(k, 1) * WEAVE_TRANSLATION_NDC * amount,
    y: valueNoise1D(k, 2) * WEAVE_TRANSLATION_NDC * amount,
    rollDeg: valueNoise1D(k, 3) * WEAVE_ROLL_DEG * amount,
  };
}
