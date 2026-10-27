import { describe, expect, it } from 'vitest';
import { deg2rad, focalFromFov, fovFromFocal, getSensor, rad2deg, sensorFov, SENSOR_FORMATS } from './sensor';
import { metersToUnits, unitsToMeters } from './scale';

describe('FOV', () => {
  it('Full Frame 50 mm : 39,6° horizontal, 27,0° vertical, 46,8° diagonal', () => {
    const f = sensorFov(getSensor('ff'), 50);
    expect(rad2deg(f.h)).toBeCloseTo(39.6, 1);
    expect(rad2deg(f.v)).toBeCloseTo(27.0, 1);
    expect(rad2deg(f.d)).toBeCloseTo(46.8, 1);
  });

  it('focale = capteur : FOV = 2·atan(0,5) = 53,13°', () => {
    expect(rad2deg(fovFromFocal(36, 36))).toBeCloseTo(53.13, 2);
  });

  it('doubler la focale divise la tangente du demi-angle par deux', () => {
    const a = Math.tan(fovFromFocal(36, 25) / 2);
    const b = Math.tan(fovFromFocal(36, 50) / 2);
    expect(a / b).toBeCloseTo(2, 10);
  });

  it('focalFromFov est l\'inverse de fovFromFocal', () => {
    for (const f of [8, 18, 35, 85, 200]) {
      expect(focalFromFov(24.89, fovFromFocal(24.89, f))).toBeCloseTo(f, 9);
    }
  });

  it('un grand capteur voit plus large à focale égale', () => {
    expect(sensorFov(getSensor('ff'), 35).h).toBeGreaterThan(sensorFov(getSensor('super16'), 35).h);
  });

  it('formats : dimensions positives, identifiants uniques', () => {
    const ids = new Set(SENSOR_FORMATS.map((s) => s.id));
    expect(ids.size).toBe(SENSOR_FORMATS.length);
    for (const s of SENSOR_FORMATS) expect(s.width).toBeGreaterThan(s.height * 0.99);
  });

  it('id inconnu : repli sur le format par défaut', () => {
    expect(getSensor('nimporte-quoi').id).toBe('s35-16x9');
  });

  it('deg2rad / rad2deg', () => {
    expect(rad2deg(deg2rad(37))).toBeCloseTo(37, 10);
  });
});

describe('échelle', () => {
  it('aller-retour unités ↔ mètres', () => {
    expect(unitsToMeters(10, 0.25)).toBe(2.5);
    expect(metersToUnits(2.5, 0.25)).toBe(10);
  });
});
