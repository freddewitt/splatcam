import { describe, expect, it } from 'vitest';
import { focusPlaneDepth, focusThroughPoint, hingeDistance, tiltGradient, tiltWarp } from './tilt';

const F = 50, D = 2000; // mm

describe('tilt (Scheimpflug)', () => {
  it('la charnière est à f / sin θ de l\'axe', () => {
    const tau = tiltGradient({ x: 0, y: -8 }, F); // y < 0 : plan plus proche en haut → τy > 0
    // Le plan coupe z = 0 où d·τ·y = d  ⇒  y = 1/τy = J.
    expect(1 / tau[1]).toBeCloseTo(hingeDistance(F, 8), 6);
    expect(hingeDistance(F, 8)).toBeCloseTo(F / Math.sin((8 * Math.PI) / 180), 6);
  });

  it('sans tilt : plan perpendiculaire, matrice identité', () => {
    const tau = tiltGradient({ x: 0, y: 0 }, F);
    expect(focusPlaneDepth(D, tau, [0.3, -0.2])).toBeCloseTo(D, 9);
    tiltWarp([12, -7], tau).forEach((m, i) => expect(m).toBeCloseTo([1, 0, 0, 1][i], 12));
  });

  it('tilt > 0 : plan plus proche en bas, swing > 0 : plus proche à droite', () => {
    const tau = tiltGradient({ x: 1, y: 1 }, F); // pente d·sin θ/f ≈ 0,7 : le plan reste devant l'objectif sur tout le champ
    expect(focusPlaneDepth(D, tau, [0, -0.3])).toBeLessThan(D);
    expect(focusPlaneDepth(D, tau, [0, 0.3])).toBeGreaterThan(D);
    expect(focusPlaneDepth(D, tau, [0.3, 0])).toBeLessThan(D);
  });

  it('la caméra décalée cisaillée voit le plan incliné comme M · (caméra centrale)', () => {
    const tau = tiltGradient({ x: 3, y: 7 }, F);
    const o: [number, number] = [14, -9];
    const M = tiltWarp(o, tau);
    for (const v of [[0, 0], [0.2, 0.15], [-0.35, 0.1], [0.05, -0.3]] as [number, number][]) {
      const s = focusPlaneDepth(D, tau, v);
      const P = [v[0] * s, v[1] * s];
      // Caméra décalée avec cisaillement pour le plan z = −D (dof.ts : v' = (P − o)/s + o/D).
      const vo = [(P[0] - o[0]) / s + o[0] / D, (P[1] - o[1]) / s + o[1] / D];
      expect(vo[0]).toBeCloseTo(M[0] * v[0] + M[1] * v[1], 9);
      expect(vo[1]).toBeCloseTo(M[2] * v[0] + M[3] * v[1], 9);
    }
  });

  it('focusThroughPoint : le plan passe bien par le point visé', () => {
    const tau = tiltGradient({ x: 0, y: 6 }, F);
    const depth = 3000, xy: [number, number] = [200, -450];
    const d = focusThroughPoint(depth, xy, tau)!;
    const s = focusPlaneDepth(d, tau, [xy[0] / depth, xy[1] / depth]);
    expect(s).toBeCloseTo(depth, 6);
  });

  it('focusThroughPoint : plan rasant → null', () => {
    expect(focusThroughPoint(1000, [0, -1e6], tiltGradient({ x: 0, y: 5 }, F))).toBeNull();
  });
});
