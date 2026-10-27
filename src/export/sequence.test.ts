import { describe, expect, it } from 'vitest';
import { exportSize, fingerprint, frameCount, frameName, frameTime, parseFrameName, pendingFrames, stableStringify } from './sequence';

describe('noms', () => {
  it('shot_00001.png pour la première image', () => {
    expect(frameName(0)).toBe('shot_00001.png');
    expect(frameName(124)).toBe('shot_00125.png');
  });
  it('lecture inverse', () => {
    expect(parseFrameName('shot_00042.png')).toBe(41);
    expect(parseFrameName('shot_123456.png')).toBe(123455);
    expect(parseFrameName('autre.png')).toBeNull();
    expect(parseFrameName('shot_42.png')).toBeNull();
  });
});

describe('temps', () => {
  it('5 s à 25 i/s = 125 images, instants i/fps, dernière image avant la fin', () => {
    expect(frameCount(5, 25)).toBe(125);
    expect(frameTime(0, 25)).toBe(0);
    expect(frameTime(124, 25)).toBeCloseTo(4.96, 10);
    expect(frameCount(0, 25)).toBe(1);
    expect(frameCount(1, 24)).toBe(24);
  });
});

describe('exportSize', () => {
  it('rapport respecté, dimensions paires', () => {
    expect(exportSize(1080, 16 / 9, 8192)).toEqual({ w: 1920, h: 1080 });
    const s = exportSize(1000, 36 / 24, 8192);
    expect(s).toEqual({ w: 1500, h: 1000 });
    expect(s.w % 2 + s.h % 2).toBe(0);
  });
  it('borné par la limite de texture, rapport conservé', () => {
    const s = exportSize(8000, 2, 8192);
    expect(Math.max(s.w, s.h)).toBeLessThanOrEqual(8192);
    expect(s.w / s.h).toBeCloseTo(2, 2);
  });
});

describe('reprise', () => {
  it('saute les images présentes', () => {
    expect(pendingFrames(6, new Set([0, 1, 3]))).toEqual([2, 4, 5]);
    expect(pendingFrames(3, new Set([0, 1, 2]))).toEqual([]);
  });
  it('empreinte stable, insensible à l\'ordre des clés, sensible aux valeurs', () => {
    const a = fingerprint(stableStringify({ x: 1, y: [1, 2], z: { b: 1, a: 2 } }));
    const b = fingerprint(stableStringify({ z: { a: 2, b: 1 }, y: [1, 2], x: 1 }));
    expect(a).toBe(b);
    expect(fingerprint(stableStringify({ x: 2, y: [1, 2], z: { b: 1, a: 2 } }))).not.toBe(a);
  });
});
