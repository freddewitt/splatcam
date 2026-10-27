// Panneau de réglages : cinq onglets (Caméra, Objectif, Mouvement, Image, Optique), groupes repliables.
// Chaque réglage numérique = curseur + valeur modifiable au clavier ; double-clic sur le libellé = valeur par défaut ;
// un point ambre signale un réglage qui s'écarte du défaut. Les échelles perceptives (focale, ouverture, map,
// échantillons) sont logarithmiques ou en dioptries, comme sur une vraie caméra.

import { getSensor, rad2deg, sensorFov, SENSOR_FORMATS, type Fov } from '../optics/sensor';
import { DEFAULT_APERTURE, type ApertureShape } from '../optics/aperture';
import { FOCUS_MARKS, FOCUS_MIN_M, dioptersFromMeters, metersFromDiopters } from '../timeline/shot';
import { parseCube, type Lut3D } from '../optics/lut';
import { DEFAULT_POST, DIRT_SIZE, type PostParams, type ToneMap } from '../render/post';
import { FILM_STOCKS, getStock, type FilmStock } from '../optics/film-stock';
import { LENS_PRESETS, getPreset, presetAperture } from '../optics/lens-preset';

export type Mode = 'explore' | 'shoot';

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
}

export interface Panel {
  /** Met à jour les valeurs affichées (FOV, distance à la cible). */
  show(fov: Fov, targetDistM: number, extra?: string): void;
  /** Reflète l'état (ex. après changement de mode au clavier, projet ouvert, télécommande). */
  sync(): void;
}

/** Rappels de l'interface vers le rendu : paramètres de post modifiés (sans refaire les sous-rendus), look chargé. */
export interface PanelHooks { post(): void; lut(lut: Lut3D | null): void; stock(stock: FilmStock | null): void; dirt(bytes: Uint8Array | null, size: number): void }

/** Valeurs par défaut des réglages hors post / ouverture (pour le double-clic et le repère « modifié »). */
const DEFAULTS = { focal: 35, fNumber: 2.8, focusM: 5, samples: 64, shiftX: 0, shiftY: 0, tiltX: 0, tiltY: 0, shutterAngle: 180, readoutMs: 0, weave: 0 };

/** Ouvertures au tiers de diaph (valeurs gravées usuelles). */
export const F_STOPS = [1, 1.1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14, 16, 18, 20, 22];
/** Indice du diaph gravé le plus proche (en diaphs, donc en log). */
export const nearestStop = (f: number): number => {
  let best = 0;
  for (let i = 1; i < F_STOPS.length; i++) if (Math.abs(Math.log(F_STOPS[i] / f)) < Math.abs(Math.log(F_STOPS[best] / f))) best = i;
  return best;
};

const STREAK_TINTS: [string, string, number[]][] = [['blue', 'Bleu', [0.35, 0.55, 1]], ['amber', 'Ambre', [1, 0.65, 0.25]], ['neutral', 'Neutre', [1, 1, 1]]];

const el = <T extends HTMLElement>(tag: string, attrs: Record<string, string> = {}, text = ''): T => {
  const e = document.createElement(tag) as T;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.textContent = text;
  return e;
};

const ICONS: Record<string, string> = {
  camera: '<path d="M3 7h3l2-2h8l2 2h3v12H3z"/><circle cx="12" cy="13" r="4"/>',
  lens: '<circle cx="12" cy="12" r="9"/><path d="M12 3l3.5 6M21 12h-7M16.5 19.8L13 14M7.5 19.8L11 14M3 12h7M8.5 4.2L12 10"/>',
  motion: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 16l5-5 4 4 3-3 6 6"/>',
  optics: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
};

let uid = 0;
const storage = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* navigation privée */ } },
};

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
    /** true : ne fait pas quitter le preset d'objectif. */
    keepPreset?: boolean;
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
      if (document.activeElement !== val) val.value = fmt(v);
      wrap.classList.toggle('changed', o.def !== undefined && Math.abs(v - o.def) > 1e-9);
    };
    const commit = (v: number) => {
      if (!Number.isFinite(v)) { upd(); return; }
      o.set(round(Math.min(Math.max(v, o.lo ?? from(o.min)), o.hi ?? from(o.max))));
      if (!o.keepPreset) state.presetId = '';
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

  /** Menu déroulant avec libellé. */
  const select = (label: string, items: [string, string][], get: () => string, set: (v: string) => void, hint?: string) => {
    const id = `ctl${uid++}`;
    const s = el<HTMLSelectElement>('select', { id });
    for (const [v, t] of items) s.append(el<HTMLOptionElement>('option', { value: v }, t));
    s.addEventListener('change', () => set(s.value));
    syncers.push(() => { s.value = get(); });
    const wrap = el('div', { class: 'ctl' });
    wrap.append(head(label, id, el('span')), s);
    if (hint) wrap.append(el('div', { class: 'hint' }, hint));
    return { wrap, select: s };
  };

  /** Boutons segmentés (choix court : cadence). */
  const segmented = (label: string, items: [string, string][], get: () => string, set: (v: string) => void) => {
    const wrap = el('div', { class: 'ctl' });
    const seg = el('div', { class: 'seg', role: 'group', 'aria-label': label });
    seg.style.display = 'flex';
    const btns = items.map(([v, t]) => {
      const b = el<HTMLButtonElement>('button', { type: 'button' }, t);
      b.style.flex = '1';
      b.addEventListener('click', () => { set(v); sync(); });
      seg.append(b);
      return [v, b] as const;
    });
    syncers.push(() => { for (const [v, b] of btns) b.classList.toggle('on', v === get()); });
    const h = el('div', { class: 'head' }); h.append(el('span', {}, label));
    wrap.append(h, seg);
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

  // ---------- Modes (dans la barre du haut) ----------
  const modesHost = document.getElementById('modes') ?? root;
  const modeBtns = (['explore', 'shoot'] as const).map((m) => {
    const b = el<HTMLButtonElement>('button', { type: 'button', 'data-mode': m, title: m === 'explore' ? 'Caméra libre de repérage (E)' : 'Caméra de tournage : capteur, objectif, timeline (T)' }, m === 'explore' ? 'Exploration' : 'Tournage');
    b.addEventListener('click', () => { state.mode = m; sync(); onChange(); });
    modesHost.append(b);
    return b;
  });

  // ---------- Onglet Caméra ----------
  const sensor = select('Capteur', SENSOR_FORMATS.map((s) => [s.id, `${s.label} · ${s.width}×${s.height} mm`]), () => state.sensorId, (v) => { state.sensorId = v; onChange(); });
  const focal = slider({
    label: 'Focale', min: Math.log(4), max: Math.log(300), step: 0.001, ...scalar('focal'),
    to: Math.log, from: Math.exp, lo: 4, hi: 800, round: (v) => Math.round(v * 10) / 10,
    fmt: (v) => `${+v.toFixed(1)} mm`, ticks: [[12, '12'], [24, '24'], [50, '50'], [100, '100'], [200, '200']],
  });
  const fnum = slider({
    label: 'Ouverture', min: 0, max: F_STOPS.length - 1, step: 1, ...scalar('fNumber'),
    to: nearestStop, from: (i) => F_STOPS[Math.round(i)], lo: 0.7, hi: 64, round: (v) => Math.round(v * 100) / 100,
    fmt: (v) => `f/${+v.toFixed(2)}`, ticks: [[1.4, '1.4'], [2.8, '2.8'], [5.6, '5.6'], [11, '11'], [22, '22']],
  });
  const focus = slider({
    label: 'Mise au point', min: 0, max: 1 / FOCUS_MIN_M, step: 0.002, ...scalar('focusM'),
    to: dioptersFromMeters, from: metersFromDiopters, lo: FOCUS_MIN_M, hi: 1000, round: (v) => Math.round(v * 1000) / 1000,
    fmt: (v) => (v >= 500 ? '∞' : `${v.toFixed(2)} m`), keepPreset: true,
    ticks: FOCUS_MARKS.filter((m) => [Infinity, 5, 2, 1, 0.5, 0.3].includes(m)).map((m) => [m, Number.isFinite(m) ? String(m) : '∞']),
    hint: 'Clic dans l\'image en vue Tournage : mise au point sur la surface visée.',
  });
  const readout = el('div', { class: 'readout' });
  const scale = el<HTMLInputElement>('input', { type: 'number', class: 'num', min: '0.0001', step: '0.01', id: `ctl${uid++}` });
  scale.addEventListener('change', () => {
    const v = parseFloat(scale.value);
    if (Number.isFinite(v) && v > 0) { state.metersPerUnit = v; onChange(); } else scale.value = String(state.metersPerUnit);
  });
  syncers.push(() => { if (document.activeElement !== scale) scale.value = String(state.metersPerUnit); });
  const scaleCtl = el('div', { class: 'ctl' });
  scaleCtl.append(head('Échelle de la scène (m par unité)', scale.id, el('span')), scale, el('div', { class: 'hint' }, 'Calibre la physique : f/1.4 à 2 m doit valoir f/1.4 à 2 m.'));
  const samples = slider({
    label: 'Échantillons à l\'arrêt', min: 0, max: 10, step: 0.01, ...scalar('samples'),
    to: Math.log2, from: (x) => 2 ** x, lo: 1, hi: 1024, round: Math.round, fmt: (v) => String(v), keepPreset: true,
    ticks: [[1, '1'], [8, '8'], [64, '64'], [512, '512']], hint: 'Qualité de l\'aperçu une fois la caméra immobile.',
  });
  const pageCamera = [
    group('optique', 'Prise de vue', [sensor.wrap, focal, fnum, focus], true, () => getSensor(state.sensorId).label),
    group('champ', 'Champ de vision', [readout]),
    group('scene', 'Scène et aperçu', [scaleCtl, samples], true),
  ];

  // ---------- Onglet Objectif ----------
  const preset = select('Preset d\'objectif', [['', 'Réglage manuel'], ...LENS_PRESETS.map((p) => [p.id, p.name] as [string, string])], () => state.presetId, (v) => {
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
    }
    sync();
    onChange();
  }, 'Règle focale, ouverture, bokeh et bascules d\'un coup. Tout réglage manuel quitte le preset.');
  const pageLens = [
    group('preset', 'Objectif', [preset.wrap], true, () => (state.presetId ? '' : 'manuel')),
    group('diaph', 'Diaphragme et bokeh', [
      lens('Lames', 'blades', 0, 16, 1, (v) => (v < 3 ? 'cercle' : String(v))),
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
  ];

  // ---------- Onglet Mouvement ----------
  const pageMotion = [
    group('obturateur', 'Obturateur', [
      segmented('Cadence', [['24', '24 i/s'], ['25', '25 i/s'], ['30', '30 i/s']], () => String(state.fps), (v) => { state.fps = parseInt(v, 10); onChange(); }),
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
      state.post.halationTint = s.halation?.tint ?? [1, 0.3, 0.1];
    }
    hooks.stock(s);
    sync();
    hooks.post();
  });
  for (const o of stock.select.options) { const s = getStock(o.value); if (s) o.title = s.description; }
  const tone = select('Tone mapping', [['aces', 'ACES (cinéma)'], ['reinhard', 'Reinhard'], ['none', 'Aucun (écrêté)']], () => state.post.toneMap, (v) => { state.post.toneMap = v as ToneMap; hooks.post(); }, 'Utilisé quand aucune émulsion n\'est choisie.');
  const iso = select('Bruit capteur', [0, 100, 200, 400, 800, 1600, 3200, 6400, 12800].map((v) => [String(v), v === 0 ? 'Aucun bruit' : `ISO ${v}`]), () => String(state.post.iso), (v) => { state.post.iso = parseInt(v, 10); hooks.post(); });
  const lut = filePicker('Look (.cube, LUT 3D Rec.709)', '.cube', () => state.lutName || 'aucun', async (f) => {
    try { hooks.lut(parseCube(await f.text())); state.lutName = f.name; } catch (e) { hooks.lut(null); state.lutName = ''; throw e; }
  }, () => { hooks.lut(null); state.lutName = ''; }, 'Retirer');
  const pageImage = [
    group('exposition', 'Exposition', [
      post('Exposition', 'exposureEv', -4, 4, 0.1, (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} EV`),
      post('Gain des hautes lumières', 'highlightGain', 1, 8, 0.1, (v) => `×${v.toFixed(1)}`, 'Laisse les lumières dépasser 1 pour nourrir bloom et halation.'),
    ], true),
    group('rendu', 'Rendu et look', [stock.wrap, tone.wrap, lut, post('Intensité du look', 'lutAmount', 0, 1, 0.01, (v) => `${Math.round(v * 100)} %`)], true,
      () => getStock(state.post.stock)?.name ?? ''),
    group('grain', 'Grain et bruit', [iso.wrap, post('Grain', 'grain', 0, 1, 0.01), post('Taille du grain', 'grainSize', 0.8, 4, 0.1, (v) => `${v.toFixed(1)} px`)], false),
  ];

  // ---------- Onglet Optique ----------
  const streak = select('Teinte du streak', STREAK_TINTS.map(([id, l]) => [id, l]), () => (STREAK_TINTS.find((t) => t[2].join() === state.post.streakTint.join()) ?? STREAK_TINTS[0])[0], (v) => {
    state.post.streakTint = STREAK_TINTS.find((x) => x[0] === v)![2];
    hooks.post();
  });
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
      post('Halation', 'halation', 0, 1, 0.01, undefined, 'Halo rouge des lumières, diffusé dans la couche anti-halo.'), post('Seuil de halation', 'halationThreshold', 0.5, 3, 0.05),
    ], true, () => on(state.post.bloom + state.post.halation)),
    group('flares', 'Flares', [
      post('Seuil des flares', 'flareThreshold', 0.5, 6, 0.05),
      post('Étoile du diaphragme', 'starburst', 0, 2, 0.01), post('Longueur de l\'étoile', 'starburstLength', 0.05, 0.6, 0.01),
      post('Pointes de l\'étoile', 'starburstSpikes', 0, 16, 1, (v) => (v === 0 ? 'selon les lames' : String(v))),
      post('Streak anamorphique', 'streak', 0, 2, 0.01), post('Longueur du streak', 'streakLength', 0, 1, 0.01), streak.wrap,
      post('Ghosts', 'ghosts', 0, 2, 0.01), post('Nombre de ghosts', 'ghostCount', 1, 6, 1),
      post('Lens dirt', 'dirt', 0, 2, 0.01), dirt,
    ], false, () => on(state.post.starburst + state.post.streak + state.post.ghosts + state.post.dirt)),
    group('geometrie', 'Vignettage et géométrie', [
      post('Vignettage naturel (cos⁴)', 'vignetteNatural', 0, 1, 0.01), post('Vignettage optique', 'vignetteOptical', 0, 1, 0.01),
      post('Distorsion', 'distortion', -0.3, 0.3, 0.005, (v) => (v === 0 ? '0' : `${v > 0 ? '+' : ''}${v.toFixed(3)}`), '+ : barillet ; − : coussinet.'),
      post('Aberration chromatique', 'chromaticAberration', 0, 1, 0.01),
    ], false, () => on(state.post.vignetteNatural + state.post.vignetteOptical + Math.abs(state.post.distortion) + state.post.chromaticAberration)),
  ];

  // ---------- Onglets ----------
  const pages: [string, string, string, HTMLElement[]][] = [
    ['camera', 'Caméra', ICONS.camera, pageCamera],
    ['lens', 'Objectif', ICONS.lens, pageLens],
    ['motion', 'Mouvement', ICONS.motion, pageMotion],
    ['image', 'Image', ICONS.image, pageImage],
    ['optics', 'Optique', ICONS.optics, pageOptics],
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
  const chips = bar ? { focal: chip(''), f: chip(''), focus: chip('map'), fov: chip('H'), sensor: chip('') } : null;

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
      chips.sensor.textContent = s.label;
    }
  }
  sync();

  return {
    sync,
    show(fov, targetDistM, extra = '') {
      const d = (r: number) => `${rad2deg(r).toFixed(1)}°`;
      readout.textContent = `Horizontal ${d(fov.h)}\nVertical   ${d(fov.v)}\nDiagonale  ${d(fov.d)}\nCible à    ${targetDistM.toFixed(2)} m${extra ? '\n' + extra : ''}`;
      sync();
    },
  };
}
