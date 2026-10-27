import { describe, expect, it } from 'vitest';
import { evalSegment, newKey, segmentControls } from './curve';
import { evaluate, moveKey, newTrack, removeKey, setKey, thin } from './track';
import { advanceTime, dioptersFromMeters, focalFromZoom, metersFromDiopters, newShot, sampleShot, zoomFromFocal } from './shot';

describe('curve', () => {
  it('passe par les clés et reste dans leur intervalle (sans dépassement)', () => {
    const tr = newTrack();
    setKey(tr, 0, 0); setKey(tr, 1, 10); setKey(tr, 2, 10.5); setKey(tr, 4, 30);
    expect(evaluate(tr, 1)).toBeCloseTo(10, 9);
    expect(evaluate(tr, 4)).toBeCloseTo(30, 9);
    let prev = -Infinity;
    for (let t = 0; t <= 4; t += 0.01) { const v = evaluate(tr, t)!; expect(v).toBeGreaterThanOrEqual(prev - 1e-9); prev = v; }
    // l'extremum local (clé plate) n'a pas de pente
    const a = newKey(0, 0), b = newKey(2, 4);
    a.hout = { dt: 1, dv: 0 }; b.hin = { dt: -1, dv: 0 };
    expect(evalSegment(a, b, 1)).toBeCloseTo(2, 3); // ease in/out symétrique
    expect(evalSegment(a, b, 0.25)).toBeLessThan(0.5); // plus lent qu'une droite au départ
  });

  it('segment linéaire et palier', () => {
    const a = newKey(0, 0), b = newKey(2, 4);
    a.mode = 'linear';
    expect(evalSegment(a, b, 0.5)).toBeCloseTo(1, 12);
    a.mode = 'hold';
    expect(evalSegment(a, b, 1.9)).toBe(0);
  });

  it('poignées bornées à la largeur du segment, pente conservée', () => {
    const a = newKey(0, 0), b = newKey(1, 1);
    a.hout = { dt: 5, dv: 5 }; b.hin = { dt: -5, dv: 0 };
    const [, p1, p2] = segmentControls(a, b);
    expect(p1).toEqual([1, 1]);
    expect(p2).toEqual([0, 1]);
    for (let t = 0; t <= 1; t += 0.05) expect(Number.isFinite(evalSegment(a, b, t))).toBe(true);
  });
});

describe('track', () => {
  it('insère trié, met à jour à temps égal, supprime', () => {
    const tr = newTrack();
    setKey(tr, 2, 1); setKey(tr, 0, 5); setKey(tr, 1, 3);
    expect(tr.keys.map((k) => k.t)).toEqual([0, 1, 2]);
    setKey(tr, 1.0004, 9);
    expect(tr.keys).toHaveLength(3);
    expect(tr.keys[1].v).toBe(9);
    removeKey(tr, 1);
    expect(tr.keys.map((k) => k.t)).toEqual([0, 2]);
  });

  it('vide → undefined ; tenue avant et après', () => {
    const tr = newTrack();
    expect(evaluate(tr, 1)).toBeUndefined();
    setKey(tr, 1, 7); setKey(tr, 3, 9);
    expect(evaluate(tr, 0)).toBe(7);
    expect(evaluate(tr, 10)).toBe(9);
  });

  it('moveKey ne franchit pas les voisines', () => {
    const tr = newTrack();
    setKey(tr, 0, 0); setKey(tr, 1, 1); setKey(tr, 2, 2);
    moveKey(tr, 1, 5, 1);
    expect(tr.keys[1].t).toBeLessThan(2);
    moveKey(tr, 1, -3, 1);
    expect(tr.keys[1].t).toBeGreaterThan(0);
  });

  it('thin supprime les clés alignées et garde les coins', () => {
    const tr = newTrack();
    for (let i = 0; i <= 10; i++) setKey(tr, i * 0.1, i <= 5 ? i : 10 - i); // montée puis descente
    thin(tr, 0.01);
    expect(tr.keys.map((k) => +k.t.toFixed(1))).toEqual([0, 0.5, 1]);
  });
});

describe('shot', () => {
  it('échantillonne uniquement les pistes qui ont des clés', () => {
    const s = newShot(4);
    setKey(s.tracks.x, 0, 0); setKey(s.tracks.x, 4, 8);
    const v = sampleShot(s, 2);
    expect(Object.keys(v)).toEqual(['x']);
    expect(v.x).toBeCloseTo(4, 6);
  });

  it('avance, boucle et s\'arrête', () => {
    const s = newShot(2);
    expect(advanceTime(1.5, 0.25, s)).toEqual({ time: 1.75, playing: true });
    expect(advanceTime(1.9, 0.3, s)).toEqual({ time: 2, playing: false });
    s.loop = true;
    const r = advanceTime(1.9, 0.3, s);
    expect(r.playing).toBe(true);
    expect(r.time).toBeCloseTo(0.2, 9);
  });

  it('bague de map en dioptries et zoom en log', () => {
    expect(metersFromDiopters(dioptersFromMeters(2))).toBeCloseTo(2, 9);
    expect(dioptersFromMeters(1e9)).toBeCloseTo(0.001, 9);
    // mi-chemin entre 35 et 70 mm en log = 49,5 mm
    expect(focalFromZoom((zoomFromFocal(35) + zoomFromFocal(70)) / 2)).toBeCloseTo(Math.sqrt(35 * 70), 9);
  });
});
