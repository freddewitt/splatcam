import { describe, expect, it } from 'vitest';
import { apertureDiameter, apertureScale, cocDiameter, dofLimits, hyperfocal, ndcWithShear } from './dof';
import { diskSample, halton } from './sampling';

describe('lentille mince', () => {
  it('ouverture : 50 mm à f/2 = 25 mm', () => {
    expect(apertureDiameter(50, 2)).toBe(25);
  });

  it('CoC nulle sur le plan de mise au point', () => {
    expect(cocDiameter(50, 1.4, 2000, 2000)).toBe(0);
  });

  it('CoC 50 mm f/1.4, map 2 m, point à 3 m : 0,3053 mm', () => {
    // A = 35,714 ; c = 35,714 · 50 · 1000 / (3000 · 1950) = 0,30525
    expect(cocDiameter(50, 1.4, 2000, 3000)).toBeCloseTo(0.30525, 4);
  });

  it('CoC tend vers A·f/(d−f) pour un point à l\'infini', () => {
    const A = apertureDiameter(50, 2);
    expect(cocDiameter(50, 2, 2000, 1e12)).toBeCloseTo((A * 50) / 1950, 4);
  });

  it('hyperfocale 50 mm f/8, c = 0,03 mm : 10 466,7 mm', () => {
    expect(hyperfocal(50, 8, 0.03)).toBeCloseTo(10466.67, 1);
  });

  it('limites de netteté : proche < map < lointaine, lointaine infinie à l\'hyperfocale', () => {
    const { near, far } = dofLimits(50, 8, 0.03, 3000);
    expect(near).toBeLessThan(3000);
    expect(far).toBeGreaterThan(3000);
    expect(dofLimits(50, 8, 0.03, hyperfocal(50, 8, 0.03)).far).toBe(Infinity);
  });
});

describe('cisaillement : la caméra décalée garde le plan de netteté fixe', () => {
  const p = 2.4, d = 5;
  it('un point du plan de netteté tombe au même pixel quel que soit le décalage', () => {
    for (const o of [-0.03, 0.01, 0.025]) {
      for (const x of [-1.2, 0, 0.7]) {
        expect(ndcWithShear(x, -d, o, p, d)).toBeCloseTo(ndcWithShear(x, -d, 0, p, d), 12);
      }
    }
  });

  it('hors plan, le déplacement vaut o·p·(1/d − 1/z)', () => {
    const o = 0.02, x = 0.3;
    for (const z of [2, 3, 10, 40]) {
      const shift = ndcWithShear(x, -z, o, p, d) - ndcWithShear(x, -z, 0, p, d);
      expect(shift).toBeCloseTo(o * p * (1 / d - 1 / z), 12);
    }
  });

  it('le disque de flou simulé a pour diamètre le CoC de la lentille mince', () => {
    // Capteur 36 mm de large, 50 mm f/1.4, map 2 m, point à 3 m, rayon d'ouverture mis à l'échelle d/(d−f).
    const f = 50, N = 1.4, d = 2000, z = 3000, sensorW = 36;
    const p = (2 * f) / sensorW; // P00 = 2f / largeur capteur
    const R = (apertureDiameter(f, N) / 2) * apertureScale(f, d);
    const offs = [-R, R];
    const xs = offs.map((o) => ndcWithShear(0, -z, o, p, d));
    const diameterNdc = Math.abs(xs[1] - xs[0]);
    const diameterMm = diameterNdc * (sensorW / 2); // NDC [-1,1] ↔ largeur capteur
    expect(diameterMm).toBeCloseTo(cocDiameter(f, N, d, z), 9);
  });
});

describe('Halton / disque', () => {
  it('halton base 2 : 1/2, 1/4, 3/4, 1/8', () => {
    expect([1, 2, 3, 4].map((i) => halton(i, 2))).toEqual([0.5, 0.25, 0.75, 0.125]);
  });

  it('tous les échantillons sont dans le disque unité, moyenne ≈ 0', () => {
    let sx = 0, sy = 0;
    const n = 256;
    for (let i = 0; i < n; i++) {
      const [x, y] = diskSample(i);
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(1);
      sx += x; sy += y;
    }
    expect(Math.abs(sx / n)).toBeLessThan(0.03);
    expect(Math.abs(sy / n)).toBeLessThan(0.03);
  });

  it('répartition uniforme en aire : ≈ 25 % des points dans r < 0,5', () => {
    const n = 1024;
    let inside = 0;
    for (let i = 0; i < n; i++) { const [x, y] = diskSample(i); if (Math.hypot(x, y) < 0.5) inside++; }
    expect(inside / n).toBeCloseTo(0.25, 1);
  });

  it('déterministe', () => {
    expect(diskSample(17)).toEqual(diskSample(17));
  });
});
