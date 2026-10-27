import { describe, expect, it } from 'vitest';
import { FILM_STOCKS, channelParams, filmCurve, filmLook, getStock, hsvToRgb, rgbToHsv, sectorValue, type FilmStock } from './film-stock';

const neutral: FilmStock = {
  id: 'n', name: 'n', description: '',
  curve: { contrast: 0.6, toe: 1, shoulder: 1, shift: 0, black: 0, white: 1 }, saturation: 1, chromaRolloff: 0,
};

describe('courbe caractéristique', () => {
  const p = channelParams(neutral)[0];

  it('gris moyen 0,18 → milieu de [noir, blanc] ; monotone ; bornée', () => {
    expect(filmCurve(0.18, p, 1, 1)).toBeCloseTo(0.5, 12);
    let prev = -1;
    for (let x = 0; x <= 32; x += 0.1) { const y = filmCurve(x, p, 1, 1); expect(y).toBeGreaterThanOrEqual(prev); expect(y).toBeLessThanOrEqual(1); prev = y; }
  });

  it('noir relevé et blanc réduit bornent la sortie', () => {
    const q = { ...p, black: 0.08, white: 0.9 };
    expect(filmCurve(0, q, 1, 1)).toBeGreaterThanOrEqual(0.08);
    expect(filmCurve(1e6, q, 1, 1)).toBeLessThanOrEqual(0.9 + 1e-9);
  });

  it('contraste : la pente au milieu croît avec k ; décalage = exposition en diaphragmes', () => {
    const slope = (k: number) => { const q = { ...p, k }; return (filmCurve(0.18 * 1.05, q, 1, 1) - filmCurve(0.18 / 1.05, q, 1, 1)); };
    expect(slope(0.9)).toBeGreaterThan(slope(0.5));
    expect(filmCurve(0.36, { ...p, shift: -1 }, 1, 1)).toBeCloseTo(filmCurve(0.18, p, 1, 1), 12);
  });

  it('pied < 1 adoucit les ombres (sortie plus haute pour un noir profond)', () => {
    expect(filmCurve(0.005, p, 0.6, 1)).toBeGreaterThan(filmCurve(0.005, p, 1, 1));
    expect(filmCurve(4, p, 1, 0.6)).toBeLessThan(filmCurve(4, p, 1, 1));
  });
});

describe('teintes et rendu complet', () => {
  it('RGB ↔ HSV aller-retour', () => {
    for (const c of [[0.2, 0.5, 0.9], [1, 0, 0], [0.3, 0.3, 0.3], [0.9, 0.8, 0.1]] as [number, number, number][]) {
      hsvToRgb(rgbToHsv(c)).forEach((v, i) => expect(v).toBeCloseTo(c[i], 9));
    }
    expect(rgbToHsv([0, 1, 0])[0]).toBeCloseTo(1 / 3, 9);
  });

  it('secteurs : valeur exacte au centre, interpolation entre deux', () => {
    const list = [1, 2, 3, 4, 5, 6];
    expect(sectorValue(list, 0)).toBe(1);
    expect(sectorValue(list, 2 / 6)).toBe(3);
    expect(sectorValue(list, 5 / 6 + 1 / 12)).toBeCloseTo((6 + 1) / 2, 9); // milieu M → R
  });

  it('gris neutre reste gris ; saturation 0 et mono donnent du gris', () => {
    const g = filmLook([0.18, 0.18, 0.18], neutral);
    expect(g[0]).toBeCloseTo(g[1], 9); expect(g[1]).toBeCloseTo(g[2], 9);
    const m = filmLook([0.6, 0.2, 0.1], { ...neutral, mono: [0.3, 0.5, 0.2] });
    expect(m[0]).toBeCloseTo(m[1], 9); expect(m[1]).toBeCloseTo(m[2], 9);
    const s0 = filmLook([0.6, 0.2, 0.1], { ...neutral, saturation: 0 });
    expect(Math.abs(s0[0] - s0[2])).toBeLessThan(1e-9);
  });

  it('la luminance par teinte ne touche pas les gris', () => {
    const st = { ...neutral, hueLum: [1.3, 1, 1, 1, 1, 1] };
    const a = filmLook([0.18, 0.18, 0.18], neutral), b = filmLook([0.18, 0.18, 0.18], st);
    b.forEach((v, i) => expect(v).toBeCloseTo(a[i], 9));
    expect(filmLook([0.5, 0.1, 0.08], st)[0]).toBeGreaterThan(filmLook([0.5, 0.1, 0.08], neutral)[0]);
  });

  it('saturation globale > 1 éloigne du gris ; désaturation vers le blanc', () => {
    const base = filmLook([0.5, 0.2, 0.1], neutral), more = filmLook([0.5, 0.2, 0.1], { ...neutral, saturation: 1.4 });
    expect(more[0] - more[2]).toBeGreaterThan(base[0] - base[2]);
    const bright = filmLook([40, 12, 4], { ...neutral, chromaRolloff: 1 }), plain = filmLook([40, 12, 4], neutral);
    expect(bright[0] - bright[2]).toBeLessThan(plain[0] - plain[2]);
  });

  it('dominante des ombres : agit dans les noirs, pas dans les blancs', () => {
    const st = { ...neutral, splitShadow: [0, 0, 0.05] };
    const dark = filmLook([0.003, 0.003, 0.003], st), light = filmLook([20, 20, 20], st);
    expect(dark[2] - dark[0]).toBeGreaterThan(0.03);
    expect(Math.abs(light[2] - light[0])).toBeLessThan(0.005);
  });

  it('les neuf préréglages sont complets et plausibles', () => {
    expect(FILM_STOCKS.length).toBe(9);
    for (const s of FILM_STOCKS) {
      expect(getStock(s.id)).toBe(s);
      for (const list of [s.hueSat, s.hueRot, s.hueLum]) if (list) expect(list).toHaveLength(6);
      for (const v of s.splitShadow ?? []) expect(Math.abs(v)).toBeLessThan(0.1);
      // gris moyen scène → sortie affichée raisonnable (0,3 à 0,7)
      const g = filmLook([0.18, 0.18, 0.18], s);
      for (const v of g) { expect(v).toBeGreaterThan(0.3); expect(v).toBeLessThan(0.7); }
      // pas de saturation fantaisiste (règle : au plus ~1,6× en cumulant)
      expect(s.saturation * Math.max(...(s.hueSat ?? [1]))).toBeLessThan(1.7);
    }
    // les familles se distinguent : Velvia plus saturée que Provia, Classic Chrome plus que Eterna... mesuré sur un rouge
    const sat = (id: string) => { const c = filmLook([0.45, 0.16, 0.1], getStock(id)!); return Math.max(...c) - Math.min(...c); };
    expect(sat('diapo-saturee')).toBeGreaterThan(sat('diapo-naturelle'));
    expect(sat('diapo-naturelle')).toBeGreaterThan(sat('chrome-classique'));
    expect(sat('bleach-bypass')).toBeLessThan(sat('diapo-naturelle'));
  });
});
