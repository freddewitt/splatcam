import { describe, expect, it } from 'vitest';
import { CONTRAST_PIVOT, DEFAULT_GRADE, LUMA, applyGrade, gradeCoefs, hueOffset, whiteBalanceGains, type Vec3 } from './grade';

const luma = (c: Vec3) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
const g = (over: Partial<typeof DEFAULT_GRADE>) => gradeCoefs({ ...DEFAULT_GRADE, ...over });

describe('balance des blancs', () => {
  it('neutre = gains 1 ; luminance d\'un gris conservée', () => {
    whiteBalanceGains(0, 0).forEach((v) => expect(v).toBeCloseTo(1, 12));
    for (const [t, m] of [[1, 0], [-0.7, 0.4], [0.3, -1]]) expect(luma(whiteBalanceGains(t, m))).toBeCloseTo(1, 12);
  });
  it('chaud : plus de rouge que de bleu, à ±1 un diaphragme d\'écart ; magenta : moins de vert', () => {
    const w = whiteBalanceGains(1, 0);
    expect(w[0] / w[2]).toBeCloseTo(2, 12);
    const m = whiteBalanceGains(0, 1);
    expect(m[1]).toBeLessThan(m[0]);
  });
});

describe('roues lift / gamma / gain', () => {
  it('la direction de couleur n\'a pas de luminance', () => {
    for (const h of [0, 40, 200, 300]) expect(luma(hueOffset(h, 1))).toBeCloseTo(0, 12);
  });
  it('réglages neutres : identité, et inactif', () => {
    const k = g({});
    expect(k.active).toBe(false);
    for (const c of [[0, 0, 0], [0.2, 0.5, 0.9], [1, 1, 1]] as Vec3[]) applyGrade(c, k).forEach((v, i) => expect(v).toBeCloseTo(c[i], 12));
  });
  it('lift déplace le noir sans toucher le blanc ; gain déplace le blanc sans toucher le noir', () => {
    const l = g({ gradeLift: 0.1 });
    expect(applyGrade([0, 0, 0], l)[0]).toBeCloseTo(0.1 ** 1, 12);
    expect(applyGrade([1, 1, 1], l)[0]).toBeCloseTo(1, 12);
    const k = g({ gradeGain: -1 });
    expect(applyGrade([0, 0, 0], k)[0]).toBeCloseTo(0, 12);
    expect(applyGrade([1, 1, 1], k)[0]).toBeCloseTo(0.5, 12);
  });
  it('gamma > 0 éclaircit les médiums, noir et blanc fixes', () => {
    const k = g({ gradeGamma: 0.5 });
    expect(applyGrade([0.4, 0.4, 0.4], k)[0]).toBeGreaterThan(0.4);
    expect(applyGrade([0, 0, 0], k)[0]).toBeCloseTo(0, 12);
    expect(applyGrade([1, 1, 1], k)[0]).toBeCloseTo(1, 12);
  });
  it('couleur des noirs bleutée : les ombres tirent vers le bleu, le blanc reste blanc', () => {
    const k = g({ gradeLiftHue: 220, gradeLiftColor: 1 });
    const s = applyGrade([0.05, 0.05, 0.05], k);
    expect(s[2]).toBeGreaterThan(s[0]);
    applyGrade([1, 1, 1], k).forEach((v) => expect(v).toBeCloseTo(1, 12));
  });
});

describe('contraste et saturation', () => {
  it('le contraste garde le pivot fixe et écarte le reste', () => {
    const k = g({ gradeContrast: 1.5 });
    expect(applyGrade([CONTRAST_PIVOT, CONTRAST_PIVOT, CONTRAST_PIVOT], k)[0]).toBeCloseTo(CONTRAST_PIVOT, 12);
    expect(applyGrade([0.7, 0.7, 0.7], k)[0]).toBeGreaterThan(0.7);
    expect(applyGrade([0.2, 0.2, 0.2], k)[0]).toBeLessThan(0.2);
  });
  it('saturation 0 = gris de même luminance ; 2 écarte les canaux', () => {
    const c: Vec3 = [0.8, 0.4, 0.2];
    const z = applyGrade(c, g({ gradeSaturation: 0 }));
    expect(z[0]).toBeCloseTo(z[2], 12);
    expect(z[0]).toBeCloseTo(luma(c), 12);
    const s = applyGrade(c, g({ gradeSaturation: 2 }));
    expect(s[0] - s[2]).toBeGreaterThan(c[0] - c[2]);
  });
  it('sortie bornée à [0, 1]', () => {
    const k = g({ gradeGain: 2, gradeContrast: 2, gradeSaturation: 2 });
    applyGrade([0.9, 0.1, 0.5], k).forEach((v) => { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); });
  });
});
