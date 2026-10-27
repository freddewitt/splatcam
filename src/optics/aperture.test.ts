import { describe, expect, it } from 'vitest';
import { ApertureSampler, DEFAULT_APERTURE, apertureMask, bladeBoundary, radialWeight, type ApertureShape } from './aperture';

const shape = (o: Partial<ApertureShape>): ApertureShape => ({ ...DEFAULT_APERTURE, ...o });

/** Fraction du disque unité acceptée par le masque (grille régulière, aire du disque = π). */
function maskArea(s: ApertureShape, f: [number, number]): number {
  const n = 200;
  let inside = 0, total = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const u: [number, number] = [((i + 0.5) / n) * 2 - 1, ((j + 0.5) / n) * 2 - 1];
    if (Math.hypot(u[0], u[1]) > 1) continue;
    total++;
    if (apertureMask(u, f, s)) inside++;
  }
  return inside / total;
}

describe('échantillonneur d\'ouverture', () => {
  it('l\'échantillon 0 est au centre', () => {
    expect(new ApertureSampler(DEFAULT_APERTURE).sample(0)).toEqual([0, 0]);
  });

  it('échantillons dans le disque unité, moyenne ≈ 0', () => {
    const sm = new ApertureSampler(DEFAULT_APERTURE);
    let sx = 0, sy = 0;
    const n = 256;
    for (let i = 0; i < n; i++) {
      const [x, y] = sm.sample(i);
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(1);
      sx += x; sy += y;
    }
    expect(Math.abs(sx / n)).toBeLessThan(0.03);
    expect(Math.abs(sy / n)).toBeLessThan(0.03);
  });

  it('répartition uniforme en aire : ≈ 25 % des points dans r < 0,5', () => {
    const sm = new ApertureSampler(DEFAULT_APERTURE);
    const n = 1024;
    let inside = 0;
    for (let i = 0; i < n; i++) { const [x, y] = sm.sample(i); if (Math.hypot(x, y) < 0.5) inside++; }
    expect(inside / n).toBeCloseTo(0.25, 1);
  });

  it('déterministe', () => {
    const a = new ApertureSampler(shape({ sphericalAberration: 0.5, rings: 0.4 }));
    const b = new ApertureSampler(shape({ sphericalAberration: 0.5, rings: 0.4 }));
    expect(a.sample(17)).toEqual(b.sample(17));
  });

  it('aberration sphérique +1 : densité ∝ 2r → 12,5 % des points dans r < 0,5', () => {
    const sm = new ApertureSampler(shape({ sphericalAberration: 1 }));
    const n = 4096;
    let inside = 0;
    for (let i = 0; i < n; i++) { const [x, y] = sm.sample(i); if (Math.hypot(x, y) < 0.5) inside++; }
    expect(inside / n).toBeCloseTo(0.125, 1);
  });

  it('aberration sphérique −1 : densité ∝ 2−2r → 50 % des points dans r < 0,5', () => {
    const sm = new ApertureSampler(shape({ sphericalAberration: -1 }));
    const n = 4096;
    let inside = 0;
    for (let i = 0; i < n; i++) { const [x, y] = sm.sample(i); if (Math.hypot(x, y) < 0.5) inside++; }
    expect(inside / n).toBeCloseTo(0.5, 1);
  });

  it('anneaux : le poids radial vaut 1 au centre et 1 − rings au creux', () => {
    const s = shape({ rings: 0.6, ringCount: 10 });
    expect(radialWeight(0, s)).toBeCloseTo(1, 12);
    expect(radialWeight(0.05, s)).toBeCloseTo(0.4, 9); // r·ringCount = 0,5 : creux
  });

  it('squeeze 2 : décalage de caméra en x divisé par 2, y inchangé', () => {
    const plain = new ApertureSampler(DEFAULT_APERTURE), sq = new ApertureSampler(shape({ squeeze: 2 }));
    const [ux, uy] = plain.sample(5), [ox, oy] = sq.offset(5);
    expect(ox).toBeCloseTo(ux / 2, 12);
    expect(oy).toBeCloseTo(uy, 12);
  });
});

describe('masque d\'ouverture', () => {
  it('cercle : tout le disque est accepté, hors disque rejeté', () => {
    expect(maskArea(DEFAULT_APERTURE, [0, 0])).toBe(1);
    expect(apertureMask([1.01, 0], [0, 0], DEFAULT_APERTURE)).toBe(false);
  });

  it('hexagone à côtés droits : aire (3√3/2)/π ≈ 0,827 du disque', () => {
    expect(maskArea(shape({ blades: 6, roundness: 0 }), [0, 0])).toBeCloseTo((3 * Math.sqrt(3)) / 2 / Math.PI, 2);
  });

  it('arrondi 1 = cercle', () => {
    expect(maskArea(shape({ blades: 6, roundness: 1 }), [0, 0])).toBe(1);
  });

  it('sommet vers le haut à rotation 0 ; apothème √3/2 sur les côtés', () => {
    const hex = shape({ blades: 6, roundness: 0 });
    expect(apertureMask([0, 0.99], [0, 0], hex)).toBe(true);
    expect(apertureMask([0.9, 0], [0, 0], hex)).toBe(false);
    expect(bladeBoundary(0, 6, 0)).toBeCloseTo(Math.sqrt(3) / 2, 12);
    expect(bladeBoundary(Math.PI / 2, 6, 0)).toBeCloseTo(1, 12);
  });

  it('rotation des lames de 30° : le sommet haut devient un côté', () => {
    const hex = shape({ blades: 6, roundness: 0, rotationDeg: 30 });
    expect(apertureMask([0, 0.99], [0, 0], hex)).toBe(false);
  });

  it('cat-eye nul au centre du champ, citron dans le coin', () => {
    const s = shape({ catEye: 1 });
    expect(maskArea(s, [0, 0])).toBe(1);
    const f: [number, number] = [1, 0]; // ρ = 1, direction +x
    // d = 1,6 : demi-longueur du citron le long du champ = 1 − 0,8 = 0,2 ; tangentielle = √(1 − 0,64) = 0,6
    expect(apertureMask([0.5, 0], f, s)).toBe(false);
    expect(apertureMask([0.1, 0], f, s)).toBe(true);
    expect(apertureMask([0, 0.5], f, s)).toBe(true);
    expect(apertureMask([0, 0.7], f, s)).toBe(false);
    expect(maskArea(s, f)).toBeLessThan(0.4);
  });

  it('le centre de l\'ouverture est accepté partout (aucun pixel sans échantillon)', () => {
    const s = shape({ blades: 5, roundness: 0.2, catEye: 1, swirlDeg: 40, rotationDeg: 17 });
    for (const f of [[0, 0], [1, 0], [0, -1], [0.7, 0.7], [-0.3, 0.9]] as [number, number][]) {
      expect(apertureMask([0, 0], f, s)).toBe(true);
    }
  });

  it('swirl : rotation de 60° d\'un hexagone (symétrie d\'ordre 6) sans effet, 30° le tourne', () => {
    const f: [number, number] = [1, 0];
    const hex60 = shape({ blades: 6, roundness: 0, swirlDeg: 60 }), hex30 = shape({ blades: 6, roundness: 0, swirlDeg: 30 });
    expect(apertureMask([0, 0.99], f, hex60)).toBe(true);
    expect(apertureMask([0, 0.99], f, hex30)).toBe(false);
    // Au centre du champ (ρ = 0) le swirl ne tourne rien.
    expect(apertureMask([0, 0.99], [0, 0], hex30)).toBe(true);
  });
});
