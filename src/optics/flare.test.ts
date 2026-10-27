import { describe, expect, it } from 'vitest';
import {
  GHOSTS, generateDirt, ghostPosition, ghostSource, starAngles, starFirstAngle, starSpikeCount, starWeight, streakMix,
} from './flare';

const deg = (r: number) => ((((r * 180) / Math.PI) % 360) + 360) % 360;

describe('étoile de diffraction', () => {
  it('N pointes pour N lames pair, 2N pour N impair, 6 sans lames', () => {
    expect(starSpikeCount(6)).toBe(6);
    expect(starSpikeCount(8)).toBe(8);
    expect(starSpikeCount(5)).toBe(10);
    expect(starSpikeCount(7)).toBe(14);
    expect(starSpikeCount(0)).toBe(6);
    expect(starSpikeCount(9, 4)).toBe(4);
  });

  it('hexagone sommet en haut : pointes à 0°, 60°, 120°… (perpendiculaires aux côtés)', () => {
    const a = starAngles(6, 0).map(deg).map((d) => Math.round(d) % 360).sort((x, y) => x - y);
    expect(a).toEqual([0, 60, 120, 180, 240, 300]);
  });

  it('pentagone : 10 pointes régulièrement espacées de 36°, symétriques par rapport au centre', () => {
    const a = starAngles(5, 0);
    expect(a).toHaveLength(10);
    for (let k = 1; k < a.length; k++) expect(deg(a[k] - a[k - 1])).toBeCloseTo(36, 6);
    // pointe opposée présente pour chaque pointe
    const set = a.map((x) => Math.round(deg(x) * 1000) / 1000);
    for (const d of set) expect(set).toContain(Math.round(((d + 180) % 360) * 1000) / 1000);
  });

  it('la rotation du diaphragme fait tourner l\'étoile', () => {
    expect(starFirstAngle(6, 15) - starFirstAngle(6, 0)).toBeCloseTo((15 * Math.PI) / 180, 12);
  });

  it('poids décroissant de 1 à 0', () => {
    expect(starWeight(0)).toBe(1);
    expect(starWeight(1)).toBe(0);
    expect(starWeight(0.25)).toBeGreaterThan(starWeight(0.5));
  });
});

describe('streak', () => {
  it('longueur 0..1 → part de montée 0,5..0,92', () => {
    expect(streakMix(0)).toBeCloseTo(0.5);
    expect(streakMix(1)).toBeCloseTo(0.92);
    expect(streakMix(5)).toBeCloseTo(0.92);
  });
});

describe('ghosts', () => {
  it('ghostSource est l\'inverse de ghostPosition', () => {
    for (const g of GHOSTS) {
      const p: [number, number] = [0.3, -0.2];
      const q = ghostPosition(p, g);
      const back = ghostSource(q, g);
      expect(back[0]).toBeCloseTo(p[0], 12);
      expect(back[1]).toBeCloseTo(p[1], 12);
    }
  });

  it('un reflet d\'échelle négative est inversé par rapport au centre', () => {
    const g = GHOSTS.find((x) => x.scale < 0)!;
    const q = ghostPosition([0.4, 0.1], g);
    expect(q[0]).toBeLessThan(0);
    expect(q[1]).toBeLessThan(0);
  });
});

describe('lens dirt', () => {
  const a = generateDirt(128, 3);

  it('déterministe selon la graine, différent d\'une graine à l\'autre', () => {
    expect(Array.from(generateDirt(128, 3))).toEqual(Array.from(a));
    expect(Array.from(generateDirt(128, 4))).not.toEqual(Array.from(a));
  });

  it('occupe la surface sans la couvrir : moyenne 2..30 %, maximum élevé, zones vides', () => {
    let sum = 0, max = 0, empty = 0;
    for (const v of a) { sum += v; max = Math.max(max, v); if (v < 5) empty++; }
    const mean = sum / a.length / 255;
    expect(mean).toBeGreaterThan(0.02);
    expect(mean).toBeLessThan(0.3);
    expect(max).toBeGreaterThan(100);
    expect(empty / a.length).toBeGreaterThan(0.3);
  });
});
