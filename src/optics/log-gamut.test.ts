import { describe, expect, it } from 'vitest';
import { F_GAMUT_C, REC2020, REC709, gamutMatrix, invert, logDecode, logEncode, lutInputSpec, rgbToXyz } from './log-gamut';

describe('F-Log / F-Log2', () => {
  it('gris moyen 0,18 : 0,4593 (F-Log), 0,3910 (F-Log2) — valeurs de colour-science', () => {
    expect(logEncode(0.18, 'flog')).toBeCloseTo(0.4593184, 6);
    expect(logEncode(0.18, 'flog2')).toBeCloseTo(0.3910072, 6);
  });

  it('noir : segment linéaire, continuité au raccord, aller-retour exact', () => {
    expect(logEncode(0, 'flog')).toBeCloseTo(0.092864, 6);
    for (const c of ['flog', 'flog2'] as const) {
      const cut = c === 'flog' ? 0.00089 : 0.000889;
      // le raccord publié a un saut de ~1e-4 (constantes arrondies de la spécification)
      expect(Math.abs(logEncode(cut + 1e-9, c) - logEncode(cut - 1e-9, c))).toBeLessThan(2e-4);
      for (const x of [0, 0.0005, 0.01, 0.18, 0.9, 4, 12]) expect(logDecode(logEncode(x, c), c)).toBeCloseTo(x, 3);
    }
  });

  it('monotone et dans 0 à 1 jusqu\'à ~ 8 de réflectance (F-Log2)', () => {
    let prev = -1;
    for (let x = 0; x <= 8; x += 0.05) { const y = logEncode(x, 'flog2'); expect(y).toBeGreaterThan(prev); expect(y).toBeLessThanOrEqual(1); prev = y; }
  });
});

describe('gamuts', () => {
  it('Rec.709 → XYZ : matrice standard', () => {
    const m = rgbToXyz(REC709);
    [0.4124, 0.3576, 0.1805, 0.2126, 0.7152, 0.0722, 0.0193, 0.1192, 0.9505].forEach((v, i) => expect(m[i]).toBeCloseTo(v, 3));
  });

  it('Rec.709 → Rec.2020 : matrice standard (ITU-R BT.2087)', () => {
    const m = gamutMatrix(REC709, REC2020);
    [0.6274, 0.3293, 0.0433, 0.0691, 0.9195, 0.0114, 0.0164, 0.088, 0.8956].forEach((v, i) => expect(m[i]).toBeCloseTo(v, 3));
  });

  it('le blanc reste blanc, les lignes somment à 1 ; aller-retour', () => {
    for (const to of [REC2020, F_GAMUT_C]) {
      const m = gamutMatrix(REC709, to);
      for (let r = 0; r < 3; r++) expect(m[r * 3] + m[r * 3 + 1] + m[r * 3 + 2]).toBeCloseTo(1, 6);
      const back = gamutMatrix(to, REC709), id = invert(m);
      id.forEach((v, i) => expect(v).toBeCloseTo(back[i], 6));
    }
  });

  it('modes d\'entrée de LUT', () => {
    expect(lutInputSpec('display')).toBeNull();
    expect(lutInputSpec('flog2c')!.curve).toBe('flog2');
    expect(lutInputSpec('flog')!.curve).toBe('flog');
  });
});
