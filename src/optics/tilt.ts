// Tilt / swing d'objectif : plan de netteté incliné (Scheimpflug).
//
// Géométrie (repère de la caméra, z < 0 devant, x droite, y haut, origine au centre de l'objectif).
// Un tilt θ pivote le plan de netteté autour d'une charnière parallèle à l'axe d'inclinaison, dans
// le plan de l'objectif, à la distance J = f / sin θ de l'axe (règle de Scheimpflug). Le plan passe
// par le point de mise au point (0, 0, −d) :
//     z = −d + d·(τ · (x, y))       avec τ = (±sin θx, ±sin θy) / f        (1 / longueur)
// soit une pente tan α = d·sin θ / f. Toutes les longueurs sont dans UNE même unité.
//
// Rendu par échantillonnage d'ouverture : la caméra décalée de `o` voit le plan z = −d à la même
// place que la caméra centrale (cisaillement de dof.ts). Pour un plan incliné il reste, pour tout
// point P du plan, avec v = (x, y)/(−z) (tangentes du rayon) :
//     v_décalée = (I − o · τᵀ) · v_centrale
// transformation LINÉAIRE de l'image (sans division), appliquée en post-traitement à chaque
// sous-rendu (`tiltWarp`) : les pixels du plan incliné retombent là où la caméra centrale les voit.
// Démonstration : s = −z = d / (1 + d τ·v) sur le plan ; v' = (P − o)/s + o/d = v − o·(1 + d τ·v)/d + o/d = v − o·(τ·v).

export interface Tilt {
  /** Swing (°) : > 0 = plan de netteté plus proche à droite. */
  x: number;
  /** Tilt (°) : > 0 = plan de netteté plus proche en bas. */
  y: number;
}

export const NO_TILT: Tilt = { x: 0, y: 0 };

export const isTilted = (t: Tilt): boolean => t.x !== 0 || t.y !== 0;

/** Gradient τ du plan de netteté, en 1 / unité de `focal`. */
export function tiltGradient(tilt: Tilt, focal: number): [number, number] {
  const rad = Math.PI / 180;
  return [Math.sin(tilt.x * rad) / focal, -Math.sin(tilt.y * rad) / focal];
}

/** Distance de la charnière à l'axe optique, dans le plan de l'objectif : J = f / sin θ. */
export function hingeDistance(focal: number, tiltDeg: number): number {
  return focal / Math.sin((Math.abs(tiltDeg) * Math.PI) / 180);
}

/** Profondeur (−z) du plan de netteté le long du rayon de tangentes `v`, focalisé à `focus` sur l'axe. */
export function focusPlaneDepth(focus: number, tau: [number, number], v: [number, number]): number {
  return focus / (1 + focus * (tau[0] * v[0] + tau[1] * v[1]));
}

/**
 * Distance de mise au point (sur l'axe) pour que le plan incliné passe par un point visé :
 * `depth` = −z du point, `xy` = (x, y) dans le repère de la caméra. Renvoie null si le plan est
 * rasant ou passe derrière l'objectif.
 */
export function focusThroughPoint(depth: number, xy: [number, number], tau: [number, number]): number | null {
  const k = 1 - (tau[0] * xy[0] + tau[1] * xy[1]);
  return k > 1e-3 ? depth / k : null;
}

/** Matrice 2×2 (m00, m01, m10, m11) I − o·τᵀ : tangentes du rayon vues par la caméra décalée de `o`, depuis la centrale. */
export function tiltWarp(offset: [number, number], tau: [number, number]): [number, number, number, number] {
  return [
    1 - offset[0] * tau[0], -offset[0] * tau[1],
    -offset[1] * tau[0], 1 - offset[1] * tau[1],
  ];
}
