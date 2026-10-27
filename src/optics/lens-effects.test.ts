import { describe, expect, it } from 'vitest';
import { acesFilm, distortSource, distortionFit, naturalVignette, reinhard, sensorNoiseSigma } from './lens-effects';
import { applyLut, atlasWidth, lutToAtlas, parseCube } from './lut';

describe('vignettage et distorsion', () => {
  it('cos⁴ : 1 au centre, 0,25 à 45° → cos⁴(45°) = 0,25', () => {
    expect(naturalVignette(0)).toBe(1);
    expect(naturalVignette(1)).toBeCloseTo(0.25, 12);
    expect(naturalVignette(Math.tan((30 * Math.PI) / 180) ** 2)).toBeCloseTo(Math.cos((30 * Math.PI) / 180) ** 4, 12);
  });

  it('distorsion nulle = identité ; barillet : le coin reste au coin, le milieu de côté lit plus près du centre', () => {
    expect(distortSource([0.3, -0.4], 0)).toEqual([0.3, -0.4]);
    const k = 0.12, c = Math.SQRT1_2;
    const corner = distortSource([c, c], k);
    expect(corner[0]).toBeCloseTo(c, 12);
    expect(distortionFit(k)).toBeCloseTo(1.12, 12);
    // milieu de côté : r² = 0,25 (avec aspect 1, coin à 1) ⇒ facteur (1 + k/4)/(1 + k) < 1
    expect(distortSource([0.5, 0], k)[0]).toBeLessThan(0.5);
  });

  it('coussinet : pas de division de zoom, les bords lisent plus loin', () => {
    expect(distortionFit(-0.1)).toBe(1);
    expect(distortSource([0.5, 0], -0.1)[0]).toBeGreaterThan(0.5 * 0.9);
  });
});

describe('bruit et tone mapping', () => {
  it('bruit : 3 % à ISO 800 / gris moyen, ×√8 à ISO 6400, nul si désactivé, croît avec le signal', () => {
    expect(sensorNoiseSigma(0.18, 800) / 0.18).toBeCloseTo(0.03 * Math.sqrt(0.19 * 0.18) / 0.18, 9);
    expect(sensorNoiseSigma(0.18, 6400) / sensorNoiseSigma(0.18, 800)).toBeCloseTo(Math.sqrt(8), 9);
    expect(sensorNoiseSigma(0.5, 0)).toBe(0);
    expect(sensorNoiseSigma(1, 800)).toBeGreaterThan(sensorNoiseSigma(0.1, 800));
  });

  it('courbes : monotones, bornées à 1, 0 → 0', () => {
    expect(reinhard(0)).toBe(0);
    expect(acesFilm(0)).toBe(0);
    let prev = 0;
    for (let c = 0; c <= 16; c += 0.25) { const v = acesFilm(c); expect(v).toBeGreaterThanOrEqual(prev); expect(v).toBeLessThanOrEqual(1); prev = v; }
    expect(acesFilm(0.18)).toBeCloseTo(0.267, 2);
  });
});

describe('LUT .cube', () => {
  const identity = (n: number) => {
    const lines = ['# test', 'TITLE "id"', `LUT_3D_SIZE ${n}`];
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) lines.push(`${r / (n - 1)} ${g / (n - 1)} ${b / (n - 1)}`);
    return lines.join('\n');
  };

  it('lit la taille, le titre et les entrées ; l\'identité laisse les couleurs inchangées', () => {
    const lut = parseCube(identity(5));
    expect(lut.size).toBe(5);
    expect(lut.title).toBe('id');
    const c: [number, number, number] = [0.13, 0.62, 0.91];
    const o = applyLut(lut, c);
    c.forEach((v, i) => expect(o[i]).toBeCloseTo(v, 6));
  });

  it('inversion rouge ↔ bleu : appliquée par interpolation', () => {
    const n = 3, lines = [`LUT_3D_SIZE ${n}`];
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) lines.push(`${b / 2} ${g / 2} ${r / 2}`);
    const lut = parseCube(lines.join('\n'));
    const o = applyLut(lut, [0.2, 0.5, 0.9]);
    expect(o[0]).toBeCloseTo(0.9, 6); expect(o[1]).toBeCloseTo(0.5, 6); expect(o[2]).toBeCloseTo(0.2, 6);
  });

  it('bande GPU : largeur arrondie à 16 texels, hauteur N², texel (r, g + b·N)', () => {
    const a = lutToAtlas(parseCube(identity(4)));
    expect(atlasWidth(4)).toBe(16);
    expect(atlasWidth(33)).toBe(48);
    expect(a.length).toBe(16 * 16 * 4);
    // texel (r=3, g=0, b=0) : rouge 1 ; texel (r=0, g=1, b=2) = ligne 1 + 2·4 = 9, colonne 0 : (0, 1/3, 2/3)
    expect(Array.from(a.slice(12, 16))).toEqual([1, 0, 0, 1]);
    const o = (9 * 16 + 0) * 4;
    expect(a[o]).toBe(0); expect(a[o + 1]).toBeCloseTo(1 / 3, 6); expect(a[o + 2]).toBeCloseTo(2 / 3, 6);
  });

  it('erreurs claires : LUT 1D, nombre d\'entrées, ligne illisible', () => {
    expect(() => parseCube('LUT_1D_SIZE 16')).toThrow(/1D/);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0')).toThrow(/attendues/);
    expect(() => parseCube('LUT_3D_SIZE 2\nabc')).toThrow(/illisible/);
    expect(() => parseCube('0 0 0')).toThrow(/LUT_3D_SIZE/);
  });
});
