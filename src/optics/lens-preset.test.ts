import { describe, expect, it } from 'vitest';
import { LENS_FAMILIES, LENS_POST_KEYS, LENS_PRESETS, getPreset, presetFocalLabel, presetHasFocal, presetPost } from './lens-preset';
import { DEFAULT_POST } from '../render/post';

describe('presets d\'objectif', () => {
  it('identifiants uniques, famille et champs dans les bornes', () => {
    expect(new Set(LENS_PRESETS.map((p) => p.id)).size).toBe(LENS_PRESETS.length);
    for (const p of LENS_PRESETS) {
      expect(p.family, p.id).toBeTruthy();
      expect(p.focalMm, p.id).toBeGreaterThanOrEqual(4);
      expect(p.fNumber, p.id).toBeGreaterThanOrEqual(0.7);
      if (p.maxAperture) expect(p.maxAperture, p.id).toBeLessThanOrEqual(p.fNumber);
      expect(presetHasFocal(p, p.focalMm), `${p.id} : focale par défaut hors de la série`).toBe(true);
      if (p.focals) expect([...p.focals].sort((a, b) => a - b), p.id).toEqual(p.focals);
      const a = p.aperture;
      if (a.squeeze !== undefined) expect(a.squeeze).toBeGreaterThanOrEqual(1);
      if (a.blades !== undefined) expect(a.blades).toBeLessThanOrEqual(20);
      for (const k of Object.keys(p.post ?? {})) expect(LENS_POST_KEYS as readonly string[], `${p.id}.${k}`).toContain(k);
      const post = p.post ?? {};
      if (post.distortion !== undefined) expect(Math.abs(post.distortion)).toBeLessThanOrEqual(0.3);
    }
    expect(LENS_FAMILIES[0]).toBe('Génériques');
    expect(LENS_FAMILIES).toContain('ARRI');
  });

  it('les défauts d\'objectif absents reviennent au neutre (pas d\'héritage du preset précédent)', () => {
    const neutre = presetPost(getPreset('neutre')!);
    for (const k of LENS_POST_KEYS) expect(neutre[k]).toEqual(DEFAULT_POST[k]);
    const pana = presetPost(getPreset('panavision-c-series')!);
    expect(pana.streak).toBeGreaterThan(0);
    expect(pana.streakTint).not.toBe(DEFAULT_POST.streakTint);   // copie, pas la référence partagée
  });

  it('focales d\'un zoom et d\'une série', () => {
    const zoom = getPreset('angenieux-optimo')!;
    expect(presetHasFocal(zoom, 24)).toBe(true);
    expect(presetHasFocal(zoom, 135)).toBe(true);
    expect(presetHasFocal(zoom, 300)).toBe(false);
    expect(presetFocalLabel(zoom)).toBe('zoom 24–290 mm');
    const mp = getPreset('arri-master-prime')!;
    expect(presetHasFocal(mp, 75)).toBe(true);
    expect(presetHasFocal(mp, 76)).toBe(false);
    expect(presetFocalLabel(mp)).toBe('12–150 mm (16 focales)');
  });
});
