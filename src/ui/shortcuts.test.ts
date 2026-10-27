import { describe, expect, it } from 'vitest';
import { SHORTCUTS, findShortcut, stepFNumber } from './shortcuts';

const ev = (key: string, o: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });

describe('raccourcis', () => {
  it('pas d\'ouverture : un tiers de diaph', () => {
    expect(stepFNumber(2.8, 1)).toBe(3.1);      // 2,8 × 2^(1/6) = 3,14 → 3,1
    expect(stepFNumber(2.8, -1)).toBe(2.5);     // 2,49
    expect(stepFNumber(1.4, -1)).toBe(1.25);
    expect(stepFNumber(1.4, 1)).toBe(1.55);
    expect(stepFNumber(0.8, -3)).toBe(0.7);     // butée basse
    expect(stepFNumber(60, 6)).toBe(64);        // butée haute
  });

  it('six tiers = deux diaphs entiers (rapport 2)', () => {
    expect(stepFNumber(2, 6)).toBe(4);
    expect(stepFNumber(8, -6)).toBe(4);
  });

  it('touches : lettre en majuscule, Maj + flèche, Ctrl/Cmd', () => {
    expect(findShortcut(ev('R'))?.label).toBe('Mode enregistrement');
    expect(findShortcut(ev('ArrowRight'))?.label).toBe('Image suivante');
    expect(findShortcut(ev('ArrowRight', { shiftKey: true }))?.label).toBe('1 seconde en avant');
    expect(findShortcut(ev('s', { metaKey: true }))?.label).toBe('Enregistrer le projet');
    expect(findShortcut(ev('o', { ctrlKey: true }))?.label).toBe('Ouvrir un projet');
  });

  it('Ctrl/Cmd + R (recharger), S seul et Alt + lettre ne déclenchent rien', () => {
    expect(findShortcut(ev('r', { metaKey: true }))).toBeUndefined();
    expect(findShortcut(ev('s'))).toBeUndefined();
    expect(findShortcut(ev('e', { altKey: true }))).toBeUndefined();
  });

  it('espace et suppr sont gérés ailleurs (aucune action ici)', () => {
    expect(findShortcut(ev(' '))).toBeUndefined();
    expect(findShortcut(ev('Delete'))).toBeUndefined();
  });

  it('aucune touche en double', () => {
    const ids = SHORTCUTS.map((s) => `${s.mod ? 'M' : ''}${s.shift ? 'S' : ''}${s.key}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
