import { describe, expect, it } from 'vitest';
import { exposurePlan, gateWeave, rowAccepts, sampleTime, shutterWindow, valueNoise1D } from './camera-defects';

describe('obturateur', () => {
  it('180° à 25 i/s = 1/50 s ; 360° = 1/25 s ; 0° = 0', () => {
    expect(shutterWindow(180, 25)).toBeCloseTo(1 / 50, 12);
    expect(shutterWindow(360, 25)).toBeCloseTo(1 / 25, 12);
    expect(shutterWindow(0, 25)).toBe(0);
  });

  it('sans rolling shutter : fenêtre = exposition, tout est accepté', () => {
    const p = exposurePlan(180, 25, 0);
    expect(p.span).toBeCloseTo(0.02, 12);
    expect(p.acceptance).toBe(1);
    expect(rowAccepts(0.01, 0.7, p)).toBe(true);
    expect(exposurePlan(0, 25, 0).active).toBe(false);
  });

  it('les instants couvrent [0, span) uniformément', () => {
    const p = exposurePlan(180, 25, 20);
    const n = 512;
    let sum = 0;
    for (let i = 1; i <= n; i++) { const u = sampleTime(i, p); expect(u).toBeGreaterThanOrEqual(0); expect(u).toBeLessThan(p.span); sum += u; }
    expect(sum / n).toBeCloseTo(p.span / 2, 3);
  });

  it('rolling shutter : chaque ligne accepte la fraction window/span des échantillons, la ligne du bas vient plus tard', () => {
    const p = exposurePlan(180, 25, 20); // fenêtre 20 ms, lecture 20 ms
    expect(p.acceptance).toBeCloseTo(0.5, 12);
    const n = 1024;
    for (const row of [0, 0.3, 1]) {
      let ok = 0;
      for (let i = 1; i <= n; i++) if (rowAccepts(sampleTime(i, p), row, p)) ok++;
      expect(ok / n).toBeCloseTo(p.acceptance, 1);
    }
    // un instant précoce est vu par le haut, pas par le bas
    expect(rowAccepts(0.001, 0, p)).toBe(true);
    expect(rowAccepts(0.001, 1, p)).toBe(false);
  });

  it('rolling shutter avec obturateur 0° : fenêtre minimale 10 % de la lecture', () => {
    const p = exposurePlan(0, 25, 20);
    expect(p.window).toBeCloseTo(0.002, 12);
    expect(p.active).toBe(true);
  });
});

describe('gate weave', () => {
  it('nul à amplitude 0, borné, lisse et déterministe', () => {
    const z = gateWeave(1.234, 0);
    expect(Math.abs(z.x) + Math.abs(z.y) + Math.abs(z.rollDeg)).toBe(0);
    const a = gateWeave(3.3, 1), b = gateWeave(3.3, 1);
    expect(a).toEqual(b);
    let maxStep = 0, prev = gateWeave(0, 1).x;
    for (let t = 0.01; t < 20; t += 0.01) {
      const w = gateWeave(t, 1);
      expect(Math.abs(w.x)).toBeLessThanOrEqual(0.008 + 1e-12);
      maxStep = Math.max(maxStep, Math.abs(w.x - prev)); prev = w.x;
    }
    expect(maxStep).toBeLessThan(0.002); // pas de saut brutal
  });

  it('bruit de valeur : valeurs aux entiers = hash, continu entre', () => {
    expect(valueNoise1D(2, 1)).toBeCloseTo(valueNoise1D(2 + 1e-9, 1), 6);
    expect(Math.abs(valueNoise1D(5.5, 7))).toBeLessThanOrEqual(1);
  });
});
