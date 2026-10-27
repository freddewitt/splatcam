// Panneau de réglages : sept onglets (Caméra, Objectif, Mouvement, Image, Optique, Moniteur, Scène), groupes repliables.
// Chaque réglage numérique = curseur + valeur modifiable au clavier ; double-clic sur le libellé = valeur par défaut ;
// un point ambre signale un réglage qui s'écarte du défaut. Les échelles perceptives (focale, ouverture, map,
// échantillons) sont logarithmiques ou en dioptries, comme sur une vraie caméra.

import { DEFAULT_GRADE, gradeCoefs } from '../optics/grade';
import { getSensor, rad2deg, sensorFov, SENSOR_FORMATS, type Fov } from '../optics/sensor';
import { DEFAULT_APERTURE, type ApertureShape } from '../optics/aperture';
import { dofLimits, hyperfocal } from '../optics/dof';
import { FOCUS_MARKS, FOCUS_MIN_M, dioptersFromMeters, metersFromDiopters } from '../timeline/shot';
import { parseCube, type Lut3D } from '../optics/lut';
import { DEFAULT_POST, DIRT_SIZE, NO_AIDS, type DisplayAids, type PeakingColor, type PostParams, type ToneMap } from '../render/post';
import { FILM_STOCKS, getStock, type FilmStock } from '../optics/film-stock';
import { LENS_FAMILIES, LENS_PRESETS, getPreset, presetAperture, presetFocalLabel, presetHasFocal, presetPost } from '../optics/lens-preset';

export type Mode = 'explore' | 'shoot';

/** Placement de la scène (modèle) dans le monde : translation (unités de scène), rotation (°, ordre X Y Z), échelle. */
export interface SceneTransform { x: number; y: number; z: number; rx: number; ry: number; rz: number; scale: number }
export const IDENTITY_TRANSFORM: SceneTransform = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, scale: 1 };

/** Angle ramené dans ]−180, 180]. */
export const wrapDeg = (a: number) => { const r = ((a % 360) + 360) % 360; return r > 180 ? r - 360 : r; };

export interface PanelState {
  mode: Mode;
  sensorId: string;
  focal: number;
  metersPerUnit: number;
  /** Ouverture f/N. */
  fNumber: number;
  /** Distance de mise au point, mètres. */
  focusM: number;
  /** Échantillons visés à l'arrêt. */
  samples: number;
  /** Forme d'ouverture (bokeh). */
  aperture: ApertureShape;
  /** Shift de l'objectif sur le capteur, mm (x droite, y haut). */
  shiftX: number;
  shiftY: number;
  /** Tilt (y) et swing (x) de l'objectif, degrés. */
  tiltX: number;
  tiltY: number;
  /** Cadence (i/s), angle d'obturateur (°), lecture du rolling shutter (ms), gate weave (0 = aucun, 1 = typique). */
  fps: number;
  shutterAngle: number;
  readoutMs: number;
  weave: number;
  /** Optique et pellicule (voir render/post.ts). */
  post: PostParams;
  /** Nom du look (.cube) chargé, '' = aucun. */
  lutName: string;
  dirtName: string;
  /** Preset d'objectif appliqué en dernier ('' = réglage manuel). */
  presetId: string;
  /** Placement du modèle. */
  sceneTransform: SceneTransform;
}

/** Pose de la caméra de tournage (unités de scène, degrés). */
export interface CameraPose { x: number; y: number; z: number; pan: number; tilt: number; roll: number }

export interface Panel {
  /** Met à jour les valeurs affichées (FOV, distance à la cible). */
  show(fov: Fov, targetDistM: number, extra?: string): void;
  /** Reflète l'état (ex. après changement de mode au clavier, projet ouvert, télécommande). */
  sync(): void;
  /** Active ou coupe le focus peaking (raccourci P). */
  togglePeaking(): void;
}

/** Rappels de l'interface vers le rendu et l'application. */
export interface PanelHooks {
  /** Paramètres de post modifiés (ré-affichage sans refaire les sous-rendus). */
  post(): void;
  lut(lut: Lut3D | null): void;
  stock(stock: FilmStock | null): void;
  dirt(bytes: Uint8Array | null, size: number): void;
  /** Pose de la caméra de tournage : lecture et écriture (partielle). */
  pose?: { get(): CameraPose; set(v: Partial<CameraPose>): void };
  /** Aides à l'écran (zébras, peaking, repères). */
  aids?(a: DisplayAids): void;
  /** Résolution d'aperçu : facteur sur la taille en points de l'écran (0,5 / 1 / devicePixelRatio). */
  quality?(ratio: number): void;
}

/** Valeurs par défaut des réglages hors post / ouverture (pour le double-clic et le repère « modifié »). */
const DEFAULTS = { focal: 35, fNumber: 2.8, focusM: 5, samples: 64, shiftX: 0, shiftY: 0, tiltX: 0, tiltY: 0, shutterAngle: 180, readoutMs: 0, weave: 0 };

/** Ouvertures au tiers de diaph (valeurs gravées usuelles). */
export const F_STOPS = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14, 16, 18, 20, 22];
/** Indice du diaph gravé le plus proche (en diaphs, donc en log). */
export const nearestStop = (f: number): number => {
  let best = 0;
  for (let i = 1; i < F_STOPS.length; i++) if (Math.abs(Math.log(F_STOPS[i] / f)) < Math.abs(Math.log(F_STOPS[best] / f))) best = i;
  return best;
};

/** Cadences proposées (i/s). 23,976 = 24 000 / 1 001 (NTSC). */
export const FPS_CHOICES = [23.976, 24, 25, 30, 48, 50, 60];

const SWATCHES: Record<'streak' | 'halation', [string, number[]][]> = {
  streak: [['Bleu', [0.35, 0.55, 1]], ['Ambre', [1, 0.65, 0.25]], ['Neutre', [1, 1, 1]], ['Violet', [0.7, 0.45, 1]]],
  halation: [['Rouge', [1, 0.3, 0.1]], ['Orange', [1, 0.5, 0.2]], ['Rose', [1, 0.35, 0.45]], ['Neutre', [1, 1, 1]]],
};
const MASKS: [number, string][] = [[0, 'Aucun'], [2.39, '2.39 (scope)'], [2, '2.00 (univisium)'], [1.85, '1.85 (flat)'], [1.66, '1.66'], [1.5, '3:2'], [1.333, '4:3'], [1, '1:1'], [0.5625, '9:16 (vertical)']];

const el = <T extends HTMLElement>(tag: string, attrs: Record<string, string> = {}, text = ''): T => {
  const e = document.createElement(tag) as T;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.textContent = text;
  return e;
};

const hex = (c: number[]) => '#' + c.slice(0, 3).map((v) => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

const ICONS: Record<string, string> = {
  camera: '<path d="M3 7h3l2-2h8l2 2h3v12H3z"/><circle cx="12" cy="13" r="4"/>',
  lens: '<circle cx="12" cy="12" r="9"/><path d="M12 3l3.5 6M21 12h-7M16.5 19.8L13 14M7.5 19.8L11 14M3 12h7M8.5 4.2L12 10"/>',
  motion: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 16l5-5 4 4 3-3 6 6"/>',
  optics: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4M7 8h3M7 8v3M17 13h-3M17 13v-3"/>',
  scene: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
};

let uid = 0;
const storage = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* navigation privée */ } },
};

/** Réglages enregistrés par l'utilisateur (« Mes réglages ») : objectif, capteur, obturateur, look. */
type UserPreset = { name: string; settings: Partial<PanelState> };
const USER_KEYS = ['sensorId', 'focal', 'fNumber', 'aperture', 'shiftX', 'shiftY', 'tiltX', 'tiltY', 'shutterAngle', 'readoutMs', 'weave', 'post', 'presetId'] as const;

export function createPanel(state: PanelState, onChange: () => void, hooks: PanelHooks): Panel {
  const root = document.getElementById('panel')!;
  const syncers: (() => void)[] = [];
  const fmt2 = (v: number) => String(+v.toFixed(2));

  // ---------- Briques ----------

  /** Groupe repliable ; l'état ouvert / fermé est retenu par le navigateur. */
  const group = (id: string, title: string, children: HTMLElement[], open = true, badge?: () => string) => {
    const d = el<HTMLDetailsElement>('details', { class: 'group' });
    const saved = storage.get(`splatcam.group.${id}`);
    d.open = saved === null ? open : saved === '1';
    d.addEventListener('toggle', () => storage.set(`splatcam.group.${id}`, d.open ? '1' : '0'));
    const s = el('summary', {}, title);
    if (badge) {
      const b = el('span', { class: 'badge' });
      s.append(b);
      syncers.push(() => { b.textContent = badge(); });
    }
    const body = el('div', { class: 'body' });
    body.append(...children);
    d.append(s, body);
    return d;
  };

  /** Ligne libellé + valeur, au-dessus d'un contrôle. */
  const head = (label: string, forId: string, value: HTMLElement) => {
    const h = el('div', { class: 'head' });
    h.append(el('label', { for: forId }, label), value);
    return h;
  };

  interface SliderOpts {
    label: string;
    /** Bornes du curseur, dans l'espace du curseur (après `to`). */
    min: number; max: number; step: number;
    get(): number; set(v: number): void;
    fmt?(v: number): string;
    /** Valeur par défaut (double-clic) ; absente = pas de remise à zéro. */
    def?: number;
    /** Espace du curseur ↔ valeur (échelles log, dioptries). */
    to?(v: number): number; from?(x: number): number;
    /** Bornes de la saisie au clavier (valeur), plus larges que le curseur si utile. */
    lo?: number; hi?: number;
    /** Arrondi de la valeur saisie ou glissée. */
    round?(v: number): number;
    /** true : ne fait pas quitter le preset d'objectif ; fonction : décide selon la valeur. */
    keepPreset?: boolean | ((v: number) => boolean);
    notify?(): void;
    hint?: string;
    ticks?: [number, string][];
  }

  /** Curseur + valeur modifiable au clavier. */
  const slider = (o: SliderOpts) => {
    const id = `ctl${uid++}`;
    const to = o.to ?? ((v: number) => v), from = o.from ?? ((x: number) => x);
    const fmt = o.fmt ?? fmt2, round = o.round ?? ((v: number) => v);
    const range = el<HTMLInputElement>('input', { type: 'range', id, min: String(o.min), max: String(o.max), step: String(o.step) });
    const val = el<HTMLInputElement>('input', { class: 'v', type: 'text', inputmode: 'decimal', 'aria-label': o.label, spellcheck: 'false' });
    const wrap = el('div', { class: 'ctl' });
    const upd = () => {
      const v = o.get(), x = Math.min(Math.max(to(v), o.min), o.max);
      range.value = String(x);
      range.style.setProperty('--p', `${((x - o.min) / (o.max - o.min)) * 100}%`);
      range.setAttribute('aria-valuetext', fmt(v));
      if (document.activeElement !== val) val.value = fmt(v);
      wrap.classList.toggle('changed', o.def !== undefined && Math.abs(v - o.def) > 1e-9);
    };
    const commit = (v: number) => {
      if (!Number.isFinite(v)) { upd(); return; }
      const nv = round(Math.min(Math.max(v, o.lo ?? from(o.min)), o.hi ?? from(o.max)));
      o.set(nv);
      const keep = typeof o.keepPreset === 'function' ? o.keepPreset(nv) : o.keepPreset;
      if (!keep) state.presetId = '';
      sync();
      (o.notify ?? onChange)();
    };
    range.addEventListener('input', () => commit(from(parseFloat(range.value))));
    val.addEventListener('focus', () => { val.value = fmt2(o.get()); val.select(); });
    val.addEventListener('change', () => commit(parseFloat(val.value.replace(',', '.'))));
    val.addEventListener('blur', upd);
    val.addEventListener('keydown', (e) => { if (e.key === 'Enter') val.blur(); if (e.key === 'Escape') { upd(); val.blur(); } });
    const h = head(o.label, id, val);
    if (o.def !== undefined) {
      h.title = 'Double-clic : valeur par défaut';
      h.addEventListener('dblclick', () => commit(o.def!));
    }
    wrap.append(h, range);
    if (o.ticks) {
      const t = el('div', { class: 'ticks' });
      t.style.position = 'relative'; t.style.height = '12px';
      for (const [v, label] of o.ticks) {
        const s = el('span', {}, label);
        s.style.position = 'absolute';
        s.style.left = `calc(7px + (100% - 14px) * ${(to(v) - o.min) / (o.max - o.min)})`;
        s.style.transform = 'translateX(-50%)';
        t.append(s);
      }
      wrap.append(t);
    }
    if (o.hint) wrap.append(el('div', { class: 'hint' }, o.hint));
    syncers.push(upd);
    return wrap;
  };

  /** Menu déroulant avec libellé ; `items` peut regrouper les options (optgroup). */
  const select = (label: string, items: ([string, string] | [string, [string, string][]])[], get: () => string, set: (v: string) => void, hint?: string) => {
    const id = `ctl${uid++}`;
    const s = el<HTMLSelectElement>('select', { id });
    for (const [v, t] of items) {
      if (Array.isArray(t)) {
        const g = el<HTMLOptGroupElement>('optgroup', { label: v });
        for (const [gv, gt] of t) g.append(el<HTMLOptionElement>('option', { value: gv }, gt));
        s.append(g);
      } else s.append(el<HTMLOptionElement>('option', { value: v }, t));
    }
    s.addEventListener('change', () => set(s.value));
    syncers.push(() => { s.value = get(); });
    const wrap = el('div', { class: 'ctl' });
    wrap.append(head(label, id, el('span')), s);
    if (hint) wrap.append(el('div', { class: 'hint' }, hint));
    return { wrap, select: s };
  };

  /** Boutons segmentés (choix courts : cadence, interrupteurs). */
  const segmented = (label: string, items: [string, string][], get: () => string, set: (v: string) => void) => {
    const wrap = el('div', { class: 'ctl' });
    const seg = el('div', { class: 'seg wrap', role: 'group', 'aria-label': label });
    const btns = items.map(([v, t]) => {
      const b = el<HTMLButtonElement>('button', { type: 'button' }, t);
      b.addEventListener('click', () => { set(v); sync(); });
      seg.append(b);
      return [v, b] as const;
    });
    syncers.push(() => { for (const [v, b] of btns) { b.classList.toggle('on', v === get()); b.setAttribute('aria-pressed', String(v === get())); } });
    if (label) { const h = el('div', { class: 'head' }); h.append(el('span', {}, label)); wrap.append(h); }
    wrap.append(seg);
    return wrap;
  };

  /** Interrupteur (case stylée). */
  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const id = `ctl${uid++}`;
    const wrap = el('label', { class: 'switch', for: id });
    const box = el<HTMLInputElement>('input', { type: 'checkbox', id });
    box.addEventListener('change', () => { set(box.checked); sync(); });
    syncers.push(() => { box.checked = get(); });
    wrap.append(box, el('span', {}, label));
    return wrap;
  };

  /** Champs numériques compacts en grille (pose, placement). */
  const numGrid = (fields: { label: string; get(): number; set(v: number): void; step: number; digits: number }[]) => {
    const grid = el('div', { class: 'grid3' });
    for (const f of fields) {
      const id = `ctl${uid++}`;
      const cell = el('label', { class: 'cell', for: id });
      const input = el<HTMLInputElement>('input', { type: 'number', class: 'num', id, step: String(f.step) });
      input.addEventListener('change', () => { const v = parseFloat(input.value); if (Number.isFinite(v)) f.set(v); sync(); });
      syncers.push(() => { if (document.activeElement !== input) input.value = String(+f.get().toFixed(f.digits)); });
      cell.append(el('span', {}, f.label), input);
      grid.append(cell);
    }
    return grid;
  };

  /** Couleur libre + pastilles prédéfinies. */
  const colorPicker = (label: string, swatches: [string, number[]][], get: () => number[], set: (c: number[]) => void) => {
    const id = `ctl${uid++}`;
    const wrap = el('div', { class: 'ctl' });
    const input = el<HTMLInputElement>('input', { type: 'color', id, class: 'color' });
    input.addEventListener('input', () => { set(fromHex(input.value)); hooks.post(); sync(); });
    const row = el('div', { class: 'sub' });
    for (const [name, c] of swatches) {
      const b = el<HTMLButtonElement>('button', { type: 'button', class: 'swatch', title: name, 'aria-label': name });
      b.style.background = hex(c);
      b.addEventListener('click', () => { set([...c]); hooks.post(); sync(); });
      row.append(b);
    }
    row.append(input);
    syncers.push(() => { input.value = hex(get()); });
    wrap.append(head(label, id, el('span')), row);
    return wrap;
  };

  /** Fichier (LUT, saleté) : bouton de choix, nom chargé, bouton de retrait. */
  const filePicker = (label: string, accept: string, name: () => string, load: (f: File) => Promise<void>, clear: () => void, clearLabel: string) => {
    const wrap = el('div', { class: 'ctl' });
    const input = el<HTMLInputElement>('input', { type: 'file', accept, hidden: '' });
    const pick = el<HTMLButtonElement>('button', { type: 'button', class: 'btn' }, 'Choisir…');
    const drop = el<HTMLButtonElement>('button', { type: 'button', class: 'btn ghost' }, clearLabel);
    const nm = el('span', { class: 'name' });
    const err = el('div', { class: 'hint' });
    pick.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.value = '';   // permet de recharger le même fichier
      if (!f) return;
      err.textContent = '';
      try { await load(f); } catch (e) { err.textContent = `Erreur : ${(e as Error).message}`; }
      sync();
      hooks.post();
    });
    drop.addEventListener('click', () => { clear(); err.textContent = ''; sync(); hooks.post(); });
    syncers.push(() => { nm.textContent = name(); });
    const h = el('div', { class: 'head' }); h.append(el('span', {}, label));
    const sub = el('div', { class: 'sub' }); sub.append(pick, drop, nm);
    wrap.append(h, sub, err, input);
    return wrap;
  };

  // Accès aux sous-objets (mise à jour EN PLACE : `state.post` est partagé avec le rendu).
  const ap = (k: keyof ApertureShape) => ({ get: () => state.aperture[k], set: (v: number) => { state.aperture = { ...state.aperture, [k]: v }; }, def: DEFAULT_APERTURE[k] });
  const pp = (k: keyof PostParams) => ({ get: () => state.post[k] as number, set: (v: number) => { (state.post as unknown as Record<string, number>)[k] = v; }, def: DEFAULT_POST[k] as number });
  const post = (label: string, k: keyof PostParams, min: number, max: number, step: number, fmt?: (v: number) => string, hint?: string) =>
    slider({ label, min, max, step, ...pp(k), fmt, keepPreset: true, notify: hooks.post, hint });
  const lens = (label: string, k: keyof ApertureShape, min: number, max: number, step: number, fmt?: (v: number) => string, hint?: string) =>
    slider({ label, min, max, step, ...ap(k), fmt, hint });
  const scalar = (k: keyof typeof DEFAULTS) => ({ get: () => state[k] as number, set: (v: number) => { (state as unknown as Record<string, number>)[k] = v; }, def: DEFAULTS[k] });
  const preset = () => getPreset(state.presetId);

  // ---------- Modes (dans la barre du haut) ----------
  const modesHost = document.getElementById('modes') ?? root;
  const modeBtns = (['explore', 'shoot'] as const).map((m) => {
    const b = el<HTMLButtonElement>('button', { type: 'button', 'data-mode': m, title: m === 'explore' ? 'Caméra libre de repérage (E)' : 'Caméra de tournage : capteur, objectif, timeline (T)' }, m === 'explore' ? 'Exploration' : 'Tournage');
    b.addEventListener('click', () => { state.mode = m; sync(); onChange(); });
    modesHost.append(b);
    return b;
  });

  // ---------- Onglet Caméra ----------
  const sensor = select('Capteur', SENSOR_FORMATS.map((s) => [s.id, `${s.label} · ${s.width}×${s.height} mm`] as [string, string]), () => state.sensorId, (v) => { state.sensorId = v; onChange(); });
  const focal = slider({
    label: 'Focale', min: Math.log(4), max: Math.log(300), step: 0.001, ...scalar('focal'),
    to: Math.log, from: Math.exp, lo: 4, hi: 800, round: (v) => Math.round(v * 10) / 10,
    fmt: (v) => `${+v.toFixed(1)} mm`, ticks: [[12, '12'], [24, '24'], [50, '50'], [100, '100'], [200, '200']],
    // Une focale de la série (ou dans la plage du zoom) garde l'objectif choisi.
    keepPreset: (v) => { const p = preset(); return !!p && presetHasFocal(p, v); },
  });
  const fnum = slider({
    label: 'Ouverture', min: 0, max: F_STOPS.length - 1, step: 1, ...scalar('fNumber'),
    to: nearestStop, from: (i) => F_STOPS[Math.round(i)], lo: 0.7, hi: 64, round: (v) => Math.round(v * 100) / 100,
    fmt: (v) => `f/${+v.toFixed(2)}`, ticks: [[1, '1'], [2, '2'], [4, '4'], [8, '8'], [16, '16']], keepPreset: true,
  });
  const focus = slider({
    label: 'Mise au point', min: 0, max: 1 / FOCUS_MIN_M, step: 0.002, ...scalar('focusM'),
    to: dioptersFromMeters, from: metersFromDiopters, lo: FOCUS_MIN_M, hi: 1000, round: (v) => Math.round(v * 1000) / 1000,
    fmt: (v) => (v >= 500 ? '∞' : `${v.toFixed(2)} m`), keepPreset: true,
    ticks: FOCUS_MARKS.filter((m) => [Infinity, 5, 2, 1, 0.5, 0.3].includes(m)).map((m) => [m, Number.isFinite(m) ? String(m) : '∞']),
    hint: 'Clic dans l\'image en vue Tournage : mise au point sur la surface visée.',
  });
  // Avertissements liés à l'objectif choisi : ouverture plus grande que la série, mise au point trop proche.
  const lensWarn = el('div', { class: 'warn' });
  syncers.push(() => {
    const p = preset(), w: string[] = [];
    if (p?.maxAperture && state.fNumber < p.maxAperture - 1e-6) w.push(`Plus ouvert que l'objectif (ouverture max. f/${p.maxAperture}).`);
    if (p?.minFocusM && state.focusM < p.minFocusM) w.push(`Sous la distance minimale de mise au point (${p.minFocusM} m).`);
    lensWarn.textContent = w.join(' ');
  });
  const readout = el('div', { class: 'readout' });
  const dofOut = el('div', { class: 'readout' });
  syncers.push(() => {
    // Profondeur de champ (lentille mince), CoC admissible = diagonale du capteur / 1500.
    const s = getSensor(state.sensorId), coc = Math.hypot(s.width, s.height) / 1500;
    const H = hyperfocal(state.focal, state.fNumber, coc) / 1000;
    const { near, far } = dofLimits(state.focal, state.fNumber, coc, state.focusM * 1000);
    const m = (v: number) => (!Number.isFinite(v) || v > 5000 ? '∞' : v >= 100 ? `${v.toFixed(0)} m` : `${v.toFixed(2)} m`);
    dofOut.textContent = `Net de     ${m(near / 1000)}\nà          ${m(far / 1000)}\nProfondeur ${m((far - near) / 1000)}\nHyperfocale ${m(H)}\nCoC        ${(coc * 1000).toFixed(0)} µm`;
  });
  // Position numérique de la caméra de tournage (mètres, degrés).
  const poseGrid = hooks.pose ? (() => {
    const P = hooks.pose!;
    const mpu = () => state.metersPerUnit;
    const f = (label: string, k: keyof CameraPose, metric: boolean) => ({
      label, step: metric ? 0.01 : 0.5, digits: metric ? 3 : 1,
      get: () => P.get()[k] * (metric ? mpu() : 1),
      set: (v: number) => P.set({ [k]: metric ? v / mpu() : v }),
    });
    return numGrid([f('X (m)', 'x', true), f('Y (m)', 'y', true), f('Z (m)', 'z', true), f('Pan °', 'pan', false), f('Tilt °', 'tilt', false), f('Roll °', 'roll', false)]);
  })() : null;
  const pageCamera = [
    group('optique', 'Prise de vue', [sensor.wrap, focal, fnum, focus, lensWarn], true, () => getSensor(state.sensorId).label),
    group('netteté', 'Netteté et champ', [dofOut, readout], true),
    ...(poseGrid ? [group('pose', 'Position de la caméra', [poseGrid, el('div', { class: 'hint' }, 'Caméra de tournage. Souris : glisser = tourner, Maj + glisser = déplacer, molette = avancer.')], false)] : []),
  ];

  // ---------- Onglet Objectif ----------
  const presetSel = select('Objectif', [['', 'Réglage manuel'], ...LENS_FAMILIES.map((fam) => [fam, LENS_PRESETS.filter((p) => p.family === fam).map((p) => [p.id, p.name] as [string, string])] as [string, [string, string][]])], () => state.presetId, (v) => {
    const p = getPreset(v);
    state.presetId = v;
    if (p) {
      state.focal = p.focalMm;
      state.fNumber = p.fNumber;
      state.aperture = presetAperture(p);
      state.shiftX = p.shiftMm?.x ?? 0;
      state.shiftY = p.shiftMm?.y ?? 0;
      state.tiltX = p.tiltDeg?.x ?? 0;
      state.tiltY = p.tiltDeg?.y ?? 0;
      Object.assign(state.post, presetPost(p));   // défauts de l'objectif (en place : partagé avec le rendu)
      hooks.post();
    }
    sync();
    onChange();
  });
  const lensInfo = el('div', { class: 'lensinfo' });
  const focalChips = el('div', { class: 'seg wrap' });
  syncers.push(() => {
    const p = preset();
    lensInfo.replaceChildren();
    focalChips.replaceChildren();
    if (!p) { lensInfo.append(el('div', { class: 'hint' }, 'Choisis un objectif : il règle focale, ouverture, bokeh et défauts optiques d\'un coup. Les objectifs nommés reproduisent leur caractère de façon approchée.')); return; }
    const facts = [presetFocalLabel(p), p.maxAperture ? `f/${p.maxAperture} max.` : '', p.minFocusM ? `MAP min. ${p.minFocusM} m` : ''].filter(Boolean).join(' · ');
    lensInfo.append(el('div', { class: 'facts' }, facts));
    if (p.description) lensInfo.append(el('div', { class: 'hint' }, p.description));
    const pick = (mm: number) => { state.focal = mm; sync(); onChange(); };
    const chips = p.zoom ? [p.zoom.min, ...[24, 35, 50, 85, 135, 200].filter((f) => f > p.zoom!.min && f < p.zoom!.max), p.zoom.max] : p.focals ?? [];
    if (chips.length > 1) for (const mm of chips) {
      const b = el<HTMLButtonElement>('button', { type: 'button' }, String(mm));
      b.classList.toggle('on', Math.abs(state.focal - mm) < 0.05);
      b.addEventListener('click', () => pick(mm));
      focalChips.append(b);
    }
  });
  // Mes réglages : enregistrés dans le navigateur.
  const loadUser = (): UserPreset[] => { try { return JSON.parse(storage.get('splatcam.userPresets') ?? '[]') as UserPreset[]; } catch { return []; } };
  const saveUser = (list: UserPreset[]) => storage.set('splatcam.userPresets', JSON.stringify(list));
  const userName = el<HTMLInputElement>('input', { type: 'text', class: 'num', placeholder: 'Nom (ex. « Scope chaud nuit »)', 'aria-label': 'Nom du réglage' });
  const userSave = el<HTMLButtonElement>('button', { type: 'button', class: 'btn' }, 'Enregistrer');
  const userList = el('div', { class: 'userlist' });
  const renderUser = () => {
    userList.replaceChildren();
    const list = loadUser();
    if (!list.length) userList.append(el('div', { class: 'hint' }, 'Objectif, capteur, obturateur, look et effets en un clic. Gardés dans ce navigateur.'));
    list.forEach((u, i) => {
      const row = el('div', { class: 'urow' });
      const apply = el<HTMLButtonElement>('button', { type: 'button', class: 'btn ghost' }, u.name);
      apply.addEventListener('click', () => {
        const { post: up, aperture: ua, ...rest } = u.settings;
        Object.assign(state, rest);
        if (ua) state.aperture = { ...DEFAULT_APERTURE, ...ua };
        if (up) Object.assign(state.post, up, { seed: state.post.seed });
        hooks.stock(getStock(state.post.stock) ?? null);
        hooks.post(); sync(); onChange();
      });
      const del = el<HTMLButtonElement>('button', { type: 'button', class: 'btn ghost x', title: 'Supprimer', 'aria-label': `Supprimer ${u.name}` }, '×');
      del.addEventListener('click', () => { const l = loadUser(); l.splice(i, 1); saveUser(l); renderUser(); });
      row.append(apply, del);
      userList.append(row);
    });
  };
  userSave.addEventListener('click', () => {
    const name = userName.value.trim() || `Réglage ${loadUser().length + 1}`;
    const settings: Record<string, unknown> = {};
    for (const k of USER_KEYS) settings[k] = structuredClone(state[k]);
    const list = loadUser().filter((u) => u.name !== name);
    list.push({ name, settings: settings as Partial<PanelState> });
    saveUser(list); userName.value = ''; renderUser();
  });
  renderUser();
  const userRow = el('div', { class: 'sub' }); userRow.append(userName, userSave);
  const pageLens = [
    group('preset', 'Objectif', [presetSel.wrap, lensInfo, focalChips], true, () => preset()?.family ?? 'manuel'),
    group('diaph', 'Diaphragme et bokeh', [
      lens('Lames', 'blades', 0, 20, 1, (v) => (v < 3 ? 'cercle' : String(v))),
      lens('Arrondi des lames', 'roundness', 0, 1, 0.05),
      lens('Rotation des lames', 'rotationDeg', -90, 90, 1, (v) => `${v}°`),
      lens('Squeeze anamorphique', 'squeeze', 1, 2, 0.05, (v) => `${v.toFixed(2)}×`),
    ], true, () => (state.aperture.blades < 3 ? '○' : `${state.aperture.blades} lames`)),
    group('caractere', 'Caractère', [
      lens('Aberration sphérique', 'sphericalAberration', -1, 1, 0.05, undefined, '+ : bord du disque lumineux (soap bubble) ; − : centre doux.'),
      lens('Anneaux (onion rings)', 'rings', 0, 1, 0.05),
      lens('Nombre d\'anneaux', 'ringCount', 3, 40, 1),
      lens('Cat-eye', 'catEye', 0, 1, 0.05, undefined, 'Vignettage mécanique : bokeh en amande vers les bords.'),
      lens('Swirl', 'swirlDeg', -90, 90, 1, (v) => `${v}°`, 'Rotation du bokeh en bordure (Petzval).'),
    ], false),
    group('bascule', 'Décentrement et bascule', [
      slider({ label: 'Shift horizontal', min: -20, max: 20, step: 0.5, ...scalar('shiftX'), fmt: (v) => `${v} mm` }),
      slider({ label: 'Shift vertical', min: -20, max: 20, step: 0.5, ...scalar('shiftY'), fmt: (v) => `${v} mm` }),
      slider({ label: 'Tilt', min: -10, max: 10, step: 0.1, ...scalar('tiltY'), fmt: (v) => `${v.toFixed(1)}°`, hint: '+ : netteté plus proche en bas (Scheimpflug).' }),
      slider({ label: 'Swing', min: -10, max: 10, step: 0.1, ...scalar('tiltX'), fmt: (v) => `${v.toFixed(1)}°`, hint: '+ : netteté plus proche à droite.' }),
    ], false, () => (state.shiftX || state.shiftY || state.tiltX || state.tiltY ? 'actif' : '')),
    group('mes', 'Mes réglages', [userRow, userList], false),
  ];

  // ---------- Onglet Mouvement ----------
  const pageMotion = [
    group('obturateur', 'Obturateur', [
      segmented('Cadence (i/s)', FPS_CHOICES.map((f) => [String(f), String(f)]), () => String(state.fps), (v) => { state.fps = parseFloat(v); onChange(); }),
      slider({ label: 'Angle d\'obturateur', min: 0, max: 360, step: 1, ...scalar('shutterAngle'), keepPreset: true,
        fmt: (v) => (v === 0 ? 'aucun flou' : `${v}° · 1/${Math.round((360 / v) * state.fps)} s`), hint: '180° = flou de mouvement « cinéma ».' }),
    ], true),
    group('defauts', 'Défauts de caméra', [
      slider({ label: 'Rolling shutter', min: 0, max: 40, step: 0.5, ...scalar('readoutMs'), keepPreset: true, fmt: (v) => (v === 0 ? 'global' : `${v} ms`), hint: 'Durée de lecture du capteur, du haut vers le bas.' }),
      slider({ label: 'Gate weave', min: 0, max: 3, step: 0.05, ...scalar('weave'), keepPreset: true, fmt: (v) => (v === 0 ? 'aucun' : `×${v.toFixed(2)}`), hint: 'Flottement de la pellicule dans le couloir.' }),
    ], true),
  ];

  // ---------- Onglet Image ----------
  const stock = select('Émulsion', [['', 'Aucune (tone mapping seul)'], ...FILM_STOCKS.map((s) => [s.id, s.name] as [string, string])], () => state.post.stock, (v) => {
    // Choisir une émulsion copie aussi ses réglages de grain et de halation (modifiables ensuite).
    const s = getStock(v) ?? null;
    state.post.stock = v;
    if (s) {
      state.post.grain = s.grain?.amount ?? 0; state.post.grainSize = s.grain?.size ?? 1.5;
      state.post.halation = s.halation?.amount ?? 0; state.post.halationThreshold = s.halation?.threshold ?? 1;
      state.post.halationTint = [...(s.halation?.tint ?? [1, 0.3, 0.1])];
    }
    hooks.stock(s);
    sync();
    hooks.post();
  });
  for (const o of stock.select.options) { const s = getStock(o.value); if (s) o.title = s.description; }
  const tone = select('Tone mapping', [['aces', 'ACES (cinéma)'], ['reinhard', 'Reinhard'], ['none', 'Aucun (écrêté)']], () => state.post.toneMap, (v) => { state.post.toneMap = v as ToneMap; hooks.post(); }, 'Utilisé quand aucune émulsion n\'est choisie.');
  const iso = select('Bruit capteur', [0, 100, 200, 400, 800, 1600, 3200, 6400, 12800].map((v) => [String(v), v === 0 ? 'Aucun bruit' : `ISO ${v}`] as [string, string]), () => String(state.post.iso), (v) => { state.post.iso = parseInt(v, 10); hooks.post(); });
  const lut = filePicker('Look (.cube, LUT 3D Rec.709)', '.cube', () => state.lutName || 'aucun', async (f) => {
    try { hooks.lut(parseCube(await f.text())); state.lutName = f.name; } catch (e) { hooks.lut(null); state.lutName = ''; throw e; }
  }, () => { hooks.lut(null); state.lutName = ''; }, 'Retirer');
  // Étalonnage : appliqué avant le look (LUT), la température agit sur l'image linéaire.
  const signed = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
  const HUES: [number, string][] = [[0, 'rouge'], [30, 'orange'], [55, 'jaune'], [120, 'vert'], [180, 'cyan'], [220, 'bleu'], [275, 'violet'], [320, 'magenta'], [360, 'rouge']];
  const hueName = (v: number) => `${Math.round(v)}° ${HUES.reduce((a, b) => (Math.abs(b[0] - v) < Math.abs(a[0] - v) ? b : a))[1]}`;
  const gradeReset = el('div', { class: 'ctl' });
  const gradeResetBtn = el<HTMLButtonElement>('button', { type: 'button', class: 'btn ghost' }, 'Réinitialiser l\'étalonnage');
  gradeResetBtn.addEventListener('click', () => { Object.assign(state.post, DEFAULT_GRADE); sync(); hooks.post(); });
  gradeReset.append(gradeResetBtn);
  const pageImage = [
    group('exposition', 'Exposition', [
      post('Exposition', 'exposureEv', -4, 4, 0.1, (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} EV`),
      post('Gain des hautes lumières', 'highlightGain', 1, 8, 0.1, (v) => `×${v.toFixed(1)}`, 'Laisse les lumières dépasser 1 pour nourrir bloom et halation.'),
    ], true),
    group('rendu', 'Rendu et look', [stock.wrap, tone.wrap, lut, post('Intensité du look', 'lutAmount', 0, 1, 0.01, (v) => `${Math.round(v * 100)} %`)], true,
      () => getStock(state.post.stock)?.name ?? ''),
    group('etalonnage', 'Étalonnage', [
      post('Température', 'gradeTemp', -1, 1, 0.01, signed, 'Balance des blancs, avant la courbe : + chaud, − froid.'),
      post('Teinte', 'gradeTint', -1, 1, 0.01, signed, '+ magenta, − vert.'),
      post('Contraste', 'gradeContrast', 0.5, 2, 0.01, (v) => `×${v.toFixed(2)}`),
      post('Saturation', 'gradeSaturation', 0, 2, 0.01, (v) => `${Math.round(v * 100)} %`),
      post('Lift (noirs)', 'gradeLift', -0.25, 0.25, 0.005, signed),
      post('Couleur des noirs', 'gradeLiftColor', 0, 1, 0.01, (v) => `${Math.round(v * 100)} %`),
      post('Teinte des noirs', 'gradeLiftHue', 0, 360, 1, hueName),
      post('Gamma (médiums)', 'gradeGamma', -1, 1, 0.01, signed),
      post('Couleur des médiums', 'gradeGammaColor', 0, 1, 0.01, (v) => `${Math.round(v * 100)} %`),
      post('Teinte des médiums', 'gradeGammaHue', 0, 360, 1, hueName),
      post('Gain (blancs)', 'gradeGain', -1, 1, 0.01, (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`),
      post('Couleur des blancs', 'gradeGainColor', 0, 1, 0.01, (v) => `${Math.round(v * 100)} %`),
      post('Teinte des blancs', 'gradeGainHue', 0, 360, 1, hueName),
      gradeReset,
    ], false, () => (gradeCoefs(state.post).active ? 'actif' : '')),
    group('grain', 'Grain et bruit', [iso.wrap, post('Grain', 'grain', 0, 1, 0.01), post('Taille du grain', 'grainSize', 0.8, 4, 0.1, (v) => `${v.toFixed(1)} px`)], false),
  ];

  // ---------- Onglet Optique ----------
  const dirt = filePicker('Masque de saleté (image)', 'image/*', () => state.dirtName || 'procédural', async (f) => {
    // Image → luminance 512×512 (clair = sale).
    const bmp = await createImageBitmap(f);
    const c = document.createElement('canvas');
    c.width = c.height = DIRT_SIZE;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(bmp, 0, 0, DIRT_SIZE, DIRT_SIZE);
    bmp.close();
    const px = g.getImageData(0, 0, DIRT_SIZE, DIRT_SIZE).data;
    const bytes = new Uint8Array(DIRT_SIZE * DIRT_SIZE);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(0.2126 * px[4 * i] + 0.7152 * px[4 * i + 1] + 0.0722 * px[4 * i + 2]);
    hooks.dirt(bytes, DIRT_SIZE);
    state.dirtName = f.name;
  }, () => { hooks.dirt(null, DIRT_SIZE); state.dirtName = ''; }, 'Par défaut');
  const on = (v: number) => (v > 0 ? 'actif' : '');
  const pageOptics = [
    group('bloom', 'Bloom et halation', [
      post('Bloom', 'bloom', 0, 1, 0.01), post('Seuil du bloom', 'bloomThreshold', 0.2, 4, 0.05), post('Étendue du bloom', 'bloomRadius', 0.3, 0.8, 0.01),
      post('Halation', 'halation', 0, 1, 0.01, undefined, 'Halo des lumières, diffusé dans la couche anti-halo.'), post('Seuil de halation', 'halationThreshold', 0.5, 3, 0.05),
      colorPicker('Teinte de la halation', SWATCHES.halation, () => state.post.halationTint, (c) => { state.post.halationTint = c; }),
    ], true, () => on(state.post.bloom + state.post.halation)),
    group('flares', 'Flares', [
      post('Seuil des flares', 'flareThreshold', 0.5, 6, 0.05),
      post('Étoile du diaphragme', 'starburst', 0, 2, 0.01), post('Longueur de l\'étoile', 'starburstLength', 0.05, 0.6, 0.01),
      post('Pointes de l\'étoile', 'starburstSpikes', 0, 16, 1, (v) => (v === 0 ? 'selon les lames' : String(v))),
      post('Streak anamorphique', 'streak', 0, 2, 0.01), post('Longueur du streak', 'streakLength', 0, 1, 0.01),
      colorPicker('Teinte du streak', SWATCHES.streak, () => state.post.streakTint, (c) => { state.post.streakTint = c; }),
      post('Ghosts', 'ghosts', 0, 2, 0.01), post('Nombre de ghosts', 'ghostCount', 1, 6, 1),
      post('Lens dirt', 'dirt', 0, 2, 0.01), dirt,
    ], false, () => on(state.post.starburst + state.post.streak + state.post.ghosts + state.post.dirt)),
    group('geometrie', 'Vignettage et géométrie', [
      post('Vignettage naturel (cos⁴)', 'vignetteNatural', 0, 1, 0.01), post('Vignettage optique', 'vignetteOptical', 0, 1, 0.01),
      post('Distorsion', 'distortion', -0.3, 0.3, 0.005, (v) => (v === 0 ? '0' : `${v > 0 ? '+' : ''}${v.toFixed(3)}`), '+ : barillet ; − : coussinet.'),
      post('Aberration chromatique', 'chromaticAberration', 0, 1, 0.01),
    ], false, () => on(state.post.vignetteNatural + state.post.vignetteOptical + Math.abs(state.post.distortion) + state.post.chromaticAberration)),
  ];

  // ---------- Onglet Moniteur (aperçu, aides, scène) ----------
  // Aides et qualité : préférences d'écran, gardées dans le navigateur (hors projet, jamais dans l'export).
  const aids: DisplayAids = (() => {
    try {
      const saved = JSON.parse(storage.get('splatcam.aids') ?? '{}') as Partial<DisplayAids>;
      // Ancien format : « peaking » était la force, 0 = désactivé.
      if (saved.peakingOn === undefined && typeof saved.peaking === 'number') { saved.peakingOn = saved.peaking > 0; if (saved.peaking <= 0) saved.peaking = NO_AIDS.peaking; }
      return { ...NO_AIDS, ...saved };
    } catch { return { ...NO_AIDS }; }
  })();
  const pushAids = () => { storage.set('splatcam.aids', JSON.stringify(aids)); hooks.aids?.(aids); };
  const aidSlider = (label: string, k: 'zebraLevel' | 'peaking' | 'maskOpacity', min: number, max: number, step: number, fmt: (v: number) => string, hint?: string) =>
    slider({ label, min, max, step, get: () => aids[k], set: (v) => { aids[k] = v; }, def: NO_AIDS[k], fmt, keepPreset: true, notify: pushAids, hint });
  const quality = segmented('Résolution d\'aperçu', [['0.5', '50 %'], ['1', '100 %'], ['retina', 'Retina']], () => storage.get('splatcam.quality') ?? '1', (v) => {
    storage.set('splatcam.quality', v);
    hooks.quality?.(v === 'retina' ? window.devicePixelRatio || 2 : parseFloat(v));
  });
  const samples = slider({
    label: 'Échantillons à l\'arrêt', min: 0, max: 10, step: 0.01, ...scalar('samples'),
    to: Math.log2, from: (x) => 2 ** x, lo: 1, hi: 1024, round: Math.round, fmt: (v) => String(v), keepPreset: true,
    ticks: [[1, '1'], [8, '8'], [64, '64'], [512, '512']], hint: 'Qualité de l\'aperçu une fois la caméra immobile.',
  });
  const mask = select('Masque de format', MASKS.map(([v, l]) => [String(v), l] as [string, string]), () => String(aids.maskAspect), (v) => { aids.maskAspect = parseFloat(v); pushAids(); sync(); });
  // Placement de la scène (modèle) : position, rotation, échelle, enregistrés avec le projet.
  // Les rotations et l'échelle pivotent autour du centre du modèle (voir applySceneTransform).
  const st = state.sceneTransform;
  const moveSteps: [string, string][] = [['0.01', '1 cm'], ['0.1', '10 cm'], ['1', '1 m'], ['10', '10 m']];
  const turnSteps: [string, string][] = [['1', '1°'], ['15', '15°'], ['90', '90°']];
  let moveStep = storage.get('splatcam.moveStep') ?? '0.1';
  let turnStep = storage.get('splatcam.turnStep') ?? '15';
  const moveSeg = segmented('Pas de déplacement', moveSteps, () => moveStep, (v) => { moveStep = v; storage.set('splatcam.moveStep', v); });
  const turnSeg = segmented('Pas de rotation', turnSteps, () => turnStep, (v) => { turnStep = v; storage.set('splatcam.turnStep', v); });
  /** Ligne « [−] valeur [+] » : boutons au pas choisi, saisie directe au milieu. */
  const nudge = (label: string, minus: string, plus: string, get: () => number, set: (v: number) => void, step: () => number, unit: string, digits: number) => {
    const id = `ctl${uid++}`;
    const wrap = el('div', { class: 'ctl' });
    const row = el('div', { class: 'nudge' });
    const bm = el<HTMLButtonElement>('button', { type: 'button', class: 'btn', title: minus }, `− ${minus}`);
    const bp = el<HTMLButtonElement>('button', { type: 'button', class: 'btn', title: plus }, `${plus} +`);
    const input = el<HTMLInputElement>('input', { type: 'number', class: 'num', id, step: 'any' });
    const apply = (v: number) => { set(v); sync(); onChange(); };
    bm.addEventListener('click', () => apply(get() - step()));
    bp.addEventListener('click', () => apply(get() + step()));
    input.addEventListener('change', () => { const v = parseFloat(input.value); if (Number.isFinite(v)) apply(v); else sync(); });
    syncers.push(() => { if (document.activeElement !== input) input.value = String(+get().toFixed(digits)); });
    row.append(bm, input, bp);
    wrap.append(head(`${label} (${unit})`, id, el('span')), row);
    return wrap;
  };
  const mpu = () => state.metersPerUnit;
  const move = (label: string, k: 'x' | 'y' | 'z', minus: string, plus: string) =>
    nudge(label, minus, plus, () => st[k] * mpu(), (v) => { st[k] = v / mpu(); }, () => parseFloat(moveStep), 'm', 3);
  const turn = (label: string, k: 'rx' | 'ry' | 'rz', minus: string, plus: string) =>
    nudge(label, minus, plus, () => st[k], (v) => { st[k] = wrapDeg(v); }, () => parseFloat(turnStep), '°', 1);
  const scaleSl = slider({ label: 'Échelle du modèle', min: Math.log(0.01), max: Math.log(100), step: 0.001, get: () => st.scale, set: (v) => { st.scale = v; }, def: 1,
    to: Math.log, from: Math.exp, lo: 0.001, hi: 1000, round: (v) => Math.round(v * 1000) / 1000, fmt: (v) => `×${+v.toFixed(3)}`, keepPreset: true, ticks: [[0.1, '×0.1'], [1, '×1'], [10, '×10']] });
  const resetTf = el<HTMLButtonElement>('button', { type: 'button', class: 'btn ghost' }, 'Remettre à zéro');
  resetTf.addEventListener('click', () => { Object.assign(st, IDENTITY_TRANSFORM); sync(); onChange(); });
  const flip = el<HTMLButtonElement>('button', { type: 'button', class: 'btn ghost', title: 'Beaucoup de scènes exportées sont à l\'envers (axe Y vers le bas)' }, 'Retourner (à l\'envers)');
  flip.addEventListener('click', () => { st.rx = wrapDeg(st.rx + 180); sync(); onChange(); });
  const tfRow = el('div', { class: 'ctl' }); const tfBtns = el('div', { class: 'nudge two' }); tfBtns.append(flip, resetTf); tfRow.append(tfBtns);
  const scale = el<HTMLInputElement>('input', { type: 'number', class: 'num', min: '0.0001', step: '0.01', id: `ctl${uid++}` });
  scale.addEventListener('change', () => {
    const v = parseFloat(scale.value);
    if (Number.isFinite(v) && v > 0) { state.metersPerUnit = v; sync(); onChange(); } else scale.value = String(state.metersPerUnit);
  });
  syncers.push(() => { if (document.activeElement !== scale) scale.value = String(state.metersPerUnit); });
  const scaleCtl = el('div', { class: 'ctl' });
  scaleCtl.append(head('Échelle de la scène (m par unité)', scale.id, el('span')), scale, el('div', { class: 'hint' }, 'Calibre la physique : f/1.4 à 2 m doit valoir f/1.4 à 2 m.'));
  const pageMonitor = [
    group('apercu', 'Aperçu', [quality, samples], true),
    group('aides', 'Aides à l\'exposition et au point', [
      toggle('Zébras (surexposition)', () => aids.zebra, (v) => { aids.zebra = v; pushAids(); }),
      aidSlider('Seuil des zébras', 'zebraLevel', 0.7, 1, 0.01, (v) => `${Math.round(v * 100)} %`),
      toggle('Focus peaking (P)', () => aids.peakingOn, (v) => { aids.peakingOn = v; pushAids(); }),
      aidSlider('Sensibilité du peaking', 'peaking', 0.25, 3, 0.05, (v) => `×${v.toFixed(2)}`, 'Surligne les détails nets. Plus haut : des détails moins contrastés s\'allument aussi. À vérifier une fois l\'aperçu affiné.'),
      segmented('Couleur du peaking', [['red', 'Rouge'], ['green', 'Vert'], ['blue', 'Bleu'], ['yellow', 'Jaune'], ['white', 'Blanc']],
        () => aids.peakingColor, (v) => { aids.peakingColor = v as PeakingColor; pushAids(); }),
      toggle('Image en noir et blanc sous le peaking', () => aids.peakingMono, (v) => { aids.peakingMono = v; pushAids(); }),
    ], true, () => (aids.zebra || aids.peakingOn ? 'actif' : '')),
    group('cadrage', 'Repères de cadrage', [
      toggle('Tiers', () => aids.thirds, (v) => { aids.thirds = v; pushAids(); }),
      toggle('Zones de sécurité (93 / 90 %)', () => aids.safe, (v) => { aids.safe = v; pushAids(); }),
      toggle('Croix centrale', () => aids.center, (v) => { aids.center = v; pushAids(); }),
      mask.wrap, aidSlider('Opacité du masque', 'maskOpacity', 0, 1, 0.05, (v) => `${Math.round(v * 100)} %`),
    ], true, () => (aids.thirds || aids.safe || aids.center || aids.maskAspect ? 'actif' : '')),
  ];
  const moved = () => (st.x || st.y || st.z ? 'modifié' : '');
  const turned = () => (st.rx || st.ry || st.rz ? 'modifié' : '');
  const pageScene = [
    group('scene-move', 'Déplacer la scène', [
      moveSeg,
      move('Haut / bas', 'y', 'Bas', 'Haut'),
      move('Axe X', 'x', 'X', 'X'),
      move('Axe Z', 'z', 'Z', 'Z'),
      el('div', { class: 'hint' }, 'Raccourcis : ⌥ ↑ / ⌥ ↓ (10 cm), avec Maj : 1 m.'),
    ], true, moved),
    group('scene-turn', 'Tourner la scène', [
      turnSeg,
      turn('Autour de la verticale (Y)', 'ry', 'Y', 'Y'),
      turn('Basculer (X)', 'rx', 'X', 'X'),
      turn('Pencher (Z)', 'rz', 'Z', 'Z'),
      tfRow,
      el('div', { class: 'hint' }, 'La scène tourne sur son centre. Raccourcis : ⌥ ← / ⌥ → (15°), avec Maj : 90°.'),
    ], true, turned),
    group('scene-scale', 'Échelle', [scaleSl, scaleCtl], false, () => (st.scale !== 1 ? 'modifié' : '')),
  ];

  // ---------- Onglets ----------
  const pages: [string, string, string, HTMLElement[]][] = [
    ['camera', 'Caméra', ICONS.camera, pageCamera],
    ['lens', 'Objectif', ICONS.lens, pageLens],
    ['motion', 'Cadence', ICONS.motion, pageMotion],
    ['image', 'Image', ICONS.image, pageImage],
    ['optics', 'Optique', ICONS.optics, pageOptics],
    ['monitor', 'Moniteur', ICONS.monitor, pageMonitor],
    ['scene', 'Scène', ICONS.scene, pageScene],
  ];
  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  const holder = el('div', { class: 'pages' });
  const note = el('div', { class: 'explore-note' }, 'Vue exploration : ces réglages s\'appliquent à la caméra de tournage (T).');
  const tabBtns: HTMLButtonElement[] = [], pageEls: HTMLElement[] = [];
  const showTab = (id: string) => {
    pages.forEach(([pid], i) => {
      tabBtns[i].classList.toggle('on', pid === id);
      tabBtns[i].setAttribute('aria-selected', String(pid === id));
      pageEls[i].classList.toggle('on', pid === id);
    });
    storage.set('splatcam.tab', id);
  };
  for (const [id, label, icon, children] of pages) {
    const b = el<HTMLButtonElement>('button', { type: 'button', role: 'tab', title: label });
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
    b.append(el('span', {}, label));
    b.addEventListener('click', () => showTab(id));
    tabs.append(b); tabBtns.push(b);
    const page = el('div', { class: 'page', role: 'tabpanel' });
    page.append(...children);
    holder.append(page); pageEls.push(page);
  }
  root.replaceChildren(tabs, note, holder);
  const savedTab = storage.get('splatcam.tab');
  showTab(pages.some(([id]) => id === savedTab) ? savedTab! : 'camera');

  // ---------- Barre d'objectif (haut) ----------
  const bar = document.getElementById('lensbar');
  const chip = (k: string) => { const s = el('span'); s.append(el('em', {}, k)); const v = document.createTextNode(''); s.append(v); bar?.append(s); return v; };
  const chips = bar ? { focal: chip(''), f: chip(''), focus: chip('map'), fov: chip('H'), lens: chip('') } : null;

  function sync() {
    for (const b of modeBtns) b.classList.toggle('on', b.dataset.mode === state.mode);
    for (const f of syncers) f();
    root.classList.toggle('exploring', state.mode === 'explore');
    if (chips) {
      const s = getSensor(state.sensorId);
      chips.focal.textContent = `${+state.focal.toFixed(1)} mm`;
      chips.f.textContent = `f/${+state.fNumber.toFixed(2)}`;
      chips.focus.textContent = state.focusM >= 500 ? '∞' : `${state.focusM.toFixed(2)} m`;
      chips.fov.textContent = `${rad2deg(sensorFov(s, state.focal).h).toFixed(1)}°`;
      chips.lens.textContent = preset()?.name ?? s.label;
    }
  }
  sync();
  // Préférences d'écran appliquées au démarrage.
  hooks.aids?.(aids);
  const q = storage.get('splatcam.quality');
  if (q && q !== '1') hooks.quality?.(q === 'retina' ? window.devicePixelRatio || 2 : parseFloat(q));

  return {
    sync,
    togglePeaking() { aids.peakingOn = !aids.peakingOn; pushAids(); sync(); },
    show(fov, targetDistM, extra = '') {
      const d = (r: number) => `${rad2deg(r).toFixed(1)}°`;
      readout.textContent = `Champ H    ${d(fov.h)}\nChamp V    ${d(fov.v)}\nDiagonale  ${d(fov.d)}\nCible à    ${targetDistM.toFixed(2)} m${extra ? '\n' + extra : ''}`;
      sync();
    },
  };
}
