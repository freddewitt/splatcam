// Raccourcis clavier : une table (touche, libellé, action) qui sert aussi à l'aide affichée par « ? ».
// Espace (lecture) et Suppr (supprimer la clé) sont gérés par timeline-ui : ils figurent ici pour l'aide seulement.

import { CAMERA_TRACKS, TRACK_IDS } from '../timeline/shot';
import type { TimelineController } from '../timeline/controller';

export interface ShortcutContext {
  timeline: TimelineController;
  /** true quand l'interface est verrouillée (export en cours). */
  locked(): boolean;
  setMode(mode: 'explore' | 'shoot'): void;
  /** Cadence courante, pour le pas d'une image. */
  fps(): number;
  /** Ouverture actuelle et son changement. */
  fNumber(): number;
  setFNumber(f: number): void;
  saveProject(): void;
  openProject(): void;
  openExport(): void;
  /** Déplace le modèle verticalement (mètres, + vers le haut). */
  moveScene(dyM: number): void;
  /** Tourne le modèle autour de la verticale (degrés). */
  turnScene(deg: number): void;
  /** Active ou coupe le focus peaking. */
  togglePeaking(): void;
}

export interface Shortcut {
  /** Valeur de KeyboardEvent.key (minuscule pour les lettres). */
  key: string;
  /** Exige Ctrl / Cmd. */
  mod?: boolean;
  shift?: boolean;
  /** Exige Option (Alt) ; absent : Option indifférent (sauf pour les lettres). */
  alt?: boolean;
  label: string;
  /** Texte de la touche dans l'aide. */
  display: string;
  /** Absente : raccourci géré ailleurs, listé pour l'aide. */
  run?(ctx: ShortcutContext): void;
}

/** Pas d'ouverture : un tiers de diaph, soit un rapport 2^(1/6) sur le nombre f. Arrondi à 0,1 (≥ 1) ou 0,05. */
export function stepFNumber(f: number, thirds: number): number {
  const next = f * Math.pow(2, thirds / 6);
  const r = next < 2 ? Math.round(next * 20) / 20 : Math.round(next * 10) / 10;
  return Math.min(Math.max(r, 0.7), 64);
}

const toShoot = (c: ShortcutContext) => c.setMode('shoot');

export const SHORTCUTS: Shortcut[] = [
  { key: 'e', display: 'E', label: 'Vue exploration', run: (c) => c.setMode('explore') },
  { key: 't', display: 'T', label: 'Vue tournage', run: (c) => c.setMode('shoot') },
  { key: ' ', display: 'Espace', label: 'Lecture / pause' },
  { key: 'r', display: 'R', label: 'Mode enregistrement', run: (c) => { toShoot(c); c.timeline.toggleRecord(); } },
  { key: 'l', display: 'L', label: 'Boucle', run: (c) => c.timeline.setLoop(!c.timeline.shot.loop) },
  { key: 'k', display: 'K', label: 'Clé sur caméra, map et zoom', run: (c) => { toShoot(c); c.timeline.keyNow(TRACK_IDS); } },
  { key: 'c', display: 'C', label: 'Clé sur la caméra seule', run: (c) => { toShoot(c); c.timeline.keyNow(CAMERA_TRACKS); } },
  { key: 'Delete', display: 'Suppr', label: 'Supprimer la clé sélectionnée' },
  // Placement de la scène : avant les flèches seules, qui sinon répondraient aussi avec Option.
  { key: 'ArrowUp', alt: true, shift: false, display: '⌥ ↑', label: 'Monter la scène de 10 cm', run: (c) => c.moveScene(0.1) },
  { key: 'ArrowDown', alt: true, shift: false, display: '⌥ ↓', label: 'Descendre la scène de 10 cm', run: (c) => c.moveScene(-0.1) },
  { key: 'ArrowUp', alt: true, shift: true, display: '⌥ Maj ↑', label: 'Monter la scène de 1 m', run: (c) => c.moveScene(1) },
  { key: 'ArrowDown', alt: true, shift: true, display: '⌥ Maj ↓', label: 'Descendre la scène de 1 m', run: (c) => c.moveScene(-1) },
  { key: 'ArrowLeft', alt: true, shift: false, display: '⌥ ←', label: 'Tourner la scène de 15° (−)', run: (c) => c.turnScene(-15) },
  { key: 'ArrowRight', alt: true, shift: false, display: '⌥ →', label: 'Tourner la scène de 15° (+)', run: (c) => c.turnScene(15) },
  { key: 'ArrowLeft', alt: true, shift: true, display: '⌥ Maj ←', label: 'Tourner la scène de 90° (−)', run: (c) => c.turnScene(-90) },
  { key: 'ArrowRight', alt: true, shift: true, display: '⌥ Maj →', label: 'Tourner la scène de 90° (+)', run: (c) => c.turnScene(90) },
  { key: 'ArrowLeft', display: '←', label: 'Image précédente', run: (c) => { toShoot(c); c.timeline.seek(c.timeline.time - 1 / c.fps()); } },
  { key: 'ArrowRight', display: '→', label: 'Image suivante', run: (c) => { toShoot(c); c.timeline.seek(c.timeline.time + 1 / c.fps()); } },
  { key: 'ArrowLeft', shift: true, display: 'Maj ←', label: '1 seconde en arrière', run: (c) => { toShoot(c); c.timeline.seek(c.timeline.time - 1); } },
  { key: 'ArrowRight', shift: true, display: 'Maj →', label: '1 seconde en avant', run: (c) => { toShoot(c); c.timeline.seek(c.timeline.time + 1); } },
  { key: 'Home', display: 'Début', label: 'Début du plan', run: (c) => { toShoot(c); c.timeline.seek(0); } },
  { key: 'End', display: 'Fin', label: 'Fin du plan', run: (c) => { toShoot(c); c.timeline.seek(c.timeline.shot.duration); } },
  { key: '[', display: '[', label: 'Ouvrir d\'un tiers de diaph', run: (c) => c.setFNumber(stepFNumber(c.fNumber(), -1)) },
  { key: ']', display: ']', label: 'Fermer d\'un tiers de diaph', run: (c) => c.setFNumber(stepFNumber(c.fNumber(), 1)) },
  { key: 'p', display: 'P', label: 'Focus peaking', run: (c) => c.togglePeaking() },
  { key: 'x', display: 'X', label: 'Fenêtre d\'export', run: (c) => c.openExport() },
  { key: 's', mod: true, display: 'Ctrl/Cmd S', label: 'Enregistrer le projet', run: (c) => c.saveProject() },
  { key: 'o', mod: true, display: 'Ctrl/Cmd O', label: 'Ouvrir un projet', run: (c) => c.openProject() },
  { key: '?', display: '?', label: 'Afficher / masquer cette aide' },
];

/** Raccourci correspondant à l'événement, ou undefined. Les lettres ne comptent pas avec Ctrl / Cmd / Alt non prévus. */
export function findShortcut(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): Shortcut | undefined {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // Option (Alt) sert à taper [ ] sur un clavier AZERTY de Mac : seules les lettres sont écartées avec Alt.
  if (e.altKey && /^[a-z]$/.test(key)) return undefined;
  return SHORTCUTS.find((s) => s.run && s.key === key && !!s.mod === mod && (s.alt === undefined || s.alt === e.altKey) && (s.shift === undefined ? !e.shiftKey || key.length === 1 : s.shift === e.shiftKey));
}

export function createShortcuts(ctx: ShortcutContext, help: HTMLElement): void {
  const rows = SHORTCUTS.map((s) => `<tr><td><kbd>${s.display}</kbd></td><td>${s.label}</td></tr>`).join('');
  help.innerHTML = `<div class="card"><h3>Raccourcis clavier</h3><table>${rows}</table><button type="button">Fermer</button></div>`;
  const toggle = (show = help.classList.contains('hidden')) => help.classList.toggle('hidden', !show);
  help.addEventListener('click', (e) => { if (e.target === help || (e.target as HTMLElement).tagName === 'BUTTON') toggle(false); });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLElement && e.target.matches('input, select, textarea')) return;
    if (e.key === 'Escape' && !help.classList.contains('hidden')) { toggle(false); return; }
    if (e.key === '?') { e.preventDefault(); toggle(); return; }
    if (ctx.locked()) return;
    const s = findShortcut(e);
    if (!s?.run) return;
    e.preventDefault();   // Ctrl+S / Ctrl+O ne doivent pas atteindre le navigateur
    s.run(ctx);
  });
}
