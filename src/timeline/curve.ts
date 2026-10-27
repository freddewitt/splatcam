// Courbes d'animation à poignées bézier (une valeur scalaire en fonction du temps, en secondes).
//
// Un segment entre deux clés a et b est une bézier cubique en (t, v) :
//   P0 = (a.t, a.v)   P1 = P0 + a.hout   P2 = (b.t, b.v) + b.hin   P3 = (b.t, b.v)
// avec hout.dt ≥ 0 et hin.dt ≤ 0. Les poignées sont BORNÉES à la largeur du segment (pente conservée) :
// x(u) reste alors monotone et on peut résoudre u pour un temps donné. Aucune dépendance à l'UI.

export interface Handle { dt: number; dv: number }

/** bezier = poignées ; linear = droite vers la clé suivante ; hold = palier (valeur tenue jusqu'à la clé suivante). */
export type KeyMode = 'bezier' | 'linear' | 'hold';

export interface Key {
  t: number;
  v: number;
  hin: Handle;
  hout: Handle;
  /** true : poignées recalculées automatiquement (lissage sans dépassement). Passe à false dès qu'on les déplace. */
  auto: boolean;
  /** Interpolation du segment qui PART de cette clé. */
  mode: KeyMode;
}

export type Point = [number, number];

export const newKey = (t: number, v: number): Key => ({ t, v, hin: { dt: 0, dv: 0 }, hout: { dt: 0, dv: 0 }, auto: true, mode: 'bezier' });

/** Points de contrôle P0..P3 du segment a → b, poignées bornées à sa largeur (pente conservée). */
export function segmentControls(a: Key, b: Key): [Point, Point, Point, Point] {
  const span = Math.max(b.t - a.t, 1e-9);
  const lim = (h: Handle, sign: 1 | -1): Handle => {
    const dt = Math.min(Math.max(h.dt * sign, 0), span) * sign;
    return { dt, dv: h.dt === 0 ? h.dv : (h.dv * dt) / h.dt };
  };
  const o = lim(a.hout, 1), i = lim(b.hin, -1);
  return [[a.t, a.v], [a.t + o.dt, a.v + o.dv], [b.t + i.dt, b.v + i.dv], [b.t, b.v]];
}

const bez = (p0: number, p1: number, p2: number, p3: number, u: number): number => {
  const w = 1 - u;
  return w * w * w * p0 + 3 * w * w * u * p1 + 3 * w * u * u * p2 + u * u * u * p3;
};

/** Valeur de la courbe entre a et b au temps t (a.t ≤ t ≤ b.t). */
export function evalSegment(a: Key, b: Key, t: number): number {
  if (a.mode === 'hold') return a.v;
  if (b.t <= a.t) return b.v;
  if (a.mode === 'linear') return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
  const [p0, p1, p2, p3] = segmentControls(a, b);
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { // x(u) croît avec u : dichotomie
    const mid = (lo + hi) / 2;
    if (bez(p0[0], p1[0], p2[0], p3[0], mid) < t) lo = mid; else hi = mid;
  }
  return bez(p0[1], p1[1], p2[1], p3[1], (lo + hi) / 2);
}

/**
 * Poignées automatiques de la clé i : tangente = pente entre les voisines, plafonnée (monotone) et annulée sur un extremum
 * local (pas de dépassement) et aux extrémités (départ et arrivée en douceur).
 */
export function autoHandle(keys: Key[], i: number): void {
  const k = keys[i];
  if (!k.auto) return;
  const prev = keys[i - 1], next = keys[i + 1];
  let slope = 0;
  if (prev && next) {
    const dp = (k.v - prev.v) / (k.t - prev.t), dn = (next.v - k.v) / (next.t - k.t);
    // Pente centrée, plafonnée à 3× chaque pente voisine (Fritsch-Carlson) : courbe monotone entre deux clés.
    if (dp * dn > 0) slope = Math.sign(dp) * Math.min(Math.abs((next.v - prev.v) / (next.t - prev.t)), 3 * Math.abs(dp), 3 * Math.abs(dn));
  }
  const dtOut = next ? (next.t - k.t) / 3 : 0, dtIn = prev ? (k.t - prev.t) / 3 : 0;
  k.hout = { dt: dtOut, dv: slope * dtOut };
  k.hin = { dt: -dtIn, dv: -slope * dtIn };
}
