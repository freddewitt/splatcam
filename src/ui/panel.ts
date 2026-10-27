import { rad2deg, SENSOR_FORMATS, type Fov } from '../optics/sensor';
import type { ApertureShape } from '../optics/aperture';
import { FOCUS_MARKS, FOCUS_MIN_M, dioptersFromMeters, focalFromZoom, metersFromDiopters, zoomFromFocal } from '../timeline/shot';
import { parseCube, type Lut3D } from '../optics/lut';
import type { PostParams, ToneMap } from '../render/post';
import { FILM_STOCKS, getStock, type FilmStock } from '../optics/film-stock';
import { LUT_INPUT_LABELS, type LutInput } from '../optics/log-gamut';
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
  /** Preset d'objectif appliqué en dernier ('' = réglage manuel). */
  presetId: string;
}

export interface Panel {
  /** Met à jour les valeurs affichées (FOV, distance à la cible). */
  show(fov: Fov, targetDistM: number, extra?: string): void;
  /** Reflète l'état (ex. après changement de mode au clavier). */
  sync(): void;
}

const el = <T extends HTMLElement>(tag: string, attrs: Record<string, string> = {}, text = ''): T => {
  const e = document.createElement(tag) as T;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.textContent = text;
  return e;
};

/** Panneau de contrôle HTML : mode, capteur, focale, échelle, lecture du champ de vision. */
/** Rappels de l'interface vers le rendu : paramètres de post modifiés (sans refaire les sous-rendus), look chargé. */
export interface PanelHooks { post(): void; lut(lut: Lut3D | null): void; stock(stock: FilmStock | null): void }

export function createPanel(state: PanelState, onChange: () => void, hooks: PanelHooks): Panel {
  const root = document.getElementById('panel')!;

  const modeBtns = (['explore', 'shoot'] as const).map((m) => {
    const b = el<HTMLButtonElement>('button', { 'data-mode': m }, m === 'explore' ? 'Exploration (E)' : 'Tournage (T)');
    b.addEventListener('click', () => { state.mode = m; sync(); onChange(); });
    return b;
  });
  const modeRow = el('div', { class: 'row' });
  modeRow.append(...modeBtns);

  const sensor = el<HTMLSelectElement>('select');
  for (const s of SENSOR_FORMATS) {
    sensor.append(el<HTMLOptionElement>('option', { value: s.id }, `${s.label} (${s.width}×${s.height} mm)`));
  }
  sensor.addEventListener('change', () => { state.sensorId = sensor.value; onChange(); });

  const focalNum = el<HTMLInputElement>('input', { type: 'number', min: '4', max: '800', step: '1' });
  const focalRange = el<HTMLInputElement>('input', { type: 'range', min: '4', max: '300', step: '1' });
  const setFocal = (v: number) => {
    if (!Number.isFinite(v) || v <= 0) return;
    state.focal = v;
    focalNum.value = String(v);
    focalRange.value = String(Math.min(300, v));
    onChange();
  };
  focalNum.addEventListener('input', () => setFocal(parseFloat(focalNum.value)));
  focalRange.addEventListener('input', () => setFocal(parseFloat(focalRange.value)));

  const scale = el<HTMLInputElement>('input', { type: 'number', min: '0.0001', step: '0.01' });
  scale.addEventListener('input', () => {
    const v = parseFloat(scale.value);
    if (Number.isFinite(v) && v > 0) { state.metersPerUnit = v; onChange(); }
  });

  const fnum = el<HTMLSelectElement>('select');
  for (const n of [1.2, 1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22]) fnum.append(el<HTMLOptionElement>('option', { value: String(n) }, `f/${n}`));
  fnum.addEventListener('change', () => { state.fNumber = parseFloat(fnum.value); onChange(); });

  const focus = el<HTMLInputElement>('input', { type: 'number', min: '0.1', step: '0.1' });
  focus.addEventListener('input', () => {
    const v = parseFloat(focus.value);
    if (Number.isFinite(v) && v > 0) { state.focusM = v; onChange(); }
  });

  // Bague de map : échelle en dioptries (1/m), repères gravés comme sur un objectif ; zoom : échelle log.
  const ring = el<HTMLInputElement>('input', { type: 'range', min: '0', max: String(1 / FOCUS_MIN_M), step: '0.002', list: 'ringmarks' });
  const marks = el<HTMLDataListElement>('datalist', { id: 'ringmarks' });
  for (const m of FOCUS_MARKS) marks.append(el<HTMLOptionElement>('option', { value: String(Number.isFinite(m) ? 1 / m : 0) }));
  const ringVal = el('b', { class: 'val' });
  ring.addEventListener('input', () => { state.focusM = metersFromDiopters(parseFloat(ring.value)); sync(); onChange(); });
  const zoomLog = el<HTMLInputElement>('input', { type: 'range', min: String(zoomFromFocal(4)), max: String(zoomFromFocal(300)), step: '0.002' });
  const zoomVal = el('b', { class: 'val' });
  zoomLog.addEventListener('input', () => { state.focal = Math.round(focalFromZoom(parseFloat(zoomLog.value)) * 10) / 10; sync(); onChange(); });
  const labelled = (label: string, val: HTMLElement, input: HTMLElement) => {
    const head = el('span'); head.append(label + ' ', val);
    const row = el('label', { class: 'field' }); row.append(head, input);
    return row;
  };

  const samples = el<HTMLInputElement>('input', { type: 'number', min: '1', max: '1024', step: '1' });
  samples.addEventListener('input', () => {
    const v = parseInt(samples.value, 10);
    if (Number.isFinite(v) && v >= 1) { state.samples = Math.min(1024, v); onChange(); }
  });

  // Presets d'objectif : règlent focale, ouverture, bokeh et shift d'un coup.
  const syncers: (() => void)[] = [];
  const preset = el<HTMLSelectElement>('select');
  preset.append(el<HTMLOptionElement>('option', { value: '' }, 'Réglage manuel'));
  for (const p of LENS_PRESETS) preset.append(el<HTMLOptionElement>('option', { value: p.id }, p.name));
  preset.addEventListener('change', () => {
    const p = getPreset(preset.value);
    state.presetId = preset.value;
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
  });

  /** Curseur + valeur affichée ; toute modification manuelle quitte le preset. */
  const slider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt = (v: number) => String(+v.toFixed(2)), keepPreset = false, notify: () => void = onChange) => {
    const range = el<HTMLInputElement>('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
    const val = el('b', { class: 'val' });
    const upd = () => { range.value = String(get()); val.textContent = fmt(get()); };
    range.addEventListener('input', () => {
      set(parseFloat(range.value));
      if (!keepPreset) { state.presetId = ''; preset.value = ''; }
      upd();
      notify();
    });
    syncers.push(upd);
    const head = el('span');
    head.append(label + ' ', val);
    const row = el('label', { class: 'field' });
    row.append(head, range);
    return row;
  };
  const ap = <K extends keyof ApertureShape>(k: K) => ({ get: () => state.aperture[k] as number, set: (v: number) => { state.aperture = { ...state.aperture, [k]: v }; } });

  const bokeh = [
    slider('Lames', 0, 16, 1, ap('blades').get, ap('blades').set, (v) => (v < 3 ? 'cercle' : String(v))),
    slider('Arrondi des lames', 0, 1, 0.05, ap('roundness').get, ap('roundness').set),
    slider('Rotation des lames (°)', -90, 90, 1, ap('rotationDeg').get, ap('rotationDeg').set),
    slider('Aberration sphérique', -1, 1, 0.05, ap('sphericalAberration').get, ap('sphericalAberration').set),
    slider('Anneaux (onion rings)', 0, 1, 0.05, ap('rings').get, ap('rings').set),
    slider('Nombre d\'anneaux', 3, 40, 1, ap('ringCount').get, ap('ringCount').set),
    slider('Cat-eye', 0, 1, 0.05, ap('catEye').get, ap('catEye').set),
    slider('Swirl (° en bordure)', -90, 90, 1, ap('swirlDeg').get, ap('swirlDeg').set),
    slider('Squeeze anamorphique', 1, 2, 0.05, ap('squeeze').get, ap('squeeze').set, (v) => `${v.toFixed(2)}x`),
  ];
  const shift = [
    slider('Shift horizontal (mm)', -20, 20, 0.5, () => state.shiftX, (v) => { state.shiftX = v; }),
    slider('Shift vertical (mm)', -20, 20, 0.5, () => state.shiftY, (v) => { state.shiftY = v; }),
  ];
  const tilt = [
    slider('Tilt (° ; + = netteté plus proche en bas)', -10, 10, 0.1, () => state.tiltY, (v) => { state.tiltY = v; }),
    slider('Swing (° ; + = netteté plus proche à droite)', -10, 10, 0.1, () => state.tiltX, (v) => { state.tiltX = v; }),
  ];
  const fpsSel = el<HTMLSelectElement>('select');
  for (const n of [24, 25, 30]) fpsSel.append(el<HTMLOptionElement>('option', { value: String(n) }, `${n} i/s`));
  fpsSel.addEventListener('change', () => { state.fps = parseInt(fpsSel.value, 10); onChange(); });
  const shutter = [
    slider('Angle d\'obturateur (°)', 0, 360, 1, () => state.shutterAngle, (v) => { state.shutterAngle = v; },
      (v) => (v === 0 ? 'aucun flou' : `${v}° · 1/${Math.round(360 / v * state.fps)} s`), true),
    slider('Rolling shutter (ms de lecture)', 0, 40, 0.5, () => state.readoutMs, (v) => { state.readoutMs = v; },
      (v) => (v === 0 ? 'global' : `${v} ms`), true),
    slider('Gate weave', 0, 3, 0.05, () => state.weave, (v) => { state.weave = v; },
      (v) => (v === 0 ? 'aucun' : `×${v.toFixed(2)}`), true),
  ];
  // Optique et pellicule : ne touche pas aux sous-rendus (ré-affichage de l'accumulateur seulement).
  const pp = <K extends keyof PostParams>(k: K) => ({ get: () => state.post[k] as number, set: (v: number) => { state.post = { ...state.post, [k]: v }; } });
  const post = (label: string, k: keyof PostParams, min: number, max: number, step: number, fmt?: (v: number) => string) =>
    slider(label, min, max, step, pp(k).get, pp(k).set, fmt, true, hooks.post);
  const field2 = (label: string, input: HTMLElement) => { const r = el('label', { class: 'field' }); r.append(el('span', {}, label), input); return r; };
  const toneSel = el<HTMLSelectElement>('select');
  for (const [v, l] of [['aces', 'ACES (cinéma)'], ['reinhard', 'Reinhard'], ['none', 'Aucun (écrêté)']] as const) toneSel.append(el<HTMLOptionElement>('option', { value: v }, l));
  toneSel.addEventListener('change', () => { state.post = { ...state.post, toneMap: toneSel.value as ToneMap }; hooks.post(); });
  // Émulsion : choisir copie aussi ses réglages de grain et de halation dans les curseurs (modifiables ensuite).
  const stockSel = el<HTMLSelectElement>('select');
  stockSel.append(el<HTMLOptionElement>('option', { value: '' }, 'Aucune (tone mapping seul)'));
  for (const s of FILM_STOCKS) stockSel.append(el<HTMLOptionElement>('option', { value: s.id, title: s.description }, s.name));
  stockSel.addEventListener('change', () => {
    const s = getStock(stockSel.value) ?? null;
    const next: PostParams = { ...state.post, stock: stockSel.value };
    if (s) {
      next.grain = s.grain?.amount ?? 0; next.grainSize = s.grain?.size ?? 1.5;
      next.halation = s.halation?.amount ?? 0; next.halationThreshold = s.halation?.threshold ?? 1;
      next.halationTint = s.halation?.tint ?? [1, 0.3, 0.1];
    }
    state.post = next;
    hooks.stock(s);
    sync();
    hooks.post();
  });
  const lutInputSel = el<HTMLSelectElement>('select');
  for (const [v, l] of Object.entries(LUT_INPUT_LABELS)) lutInputSel.append(el<HTMLOptionElement>('option', { value: v }, l));
  lutInputSel.addEventListener('change', () => { state.post = { ...state.post, lutInput: lutInputSel.value as LutInput }; hooks.post(); });
  const isoSel = el<HTMLSelectElement>('select');
  for (const v of [0, 100, 200, 400, 800, 1600, 3200, 6400, 12800]) isoSel.append(el<HTMLOptionElement>('option', { value: String(v) }, v === 0 ? 'Aucun bruit' : `ISO ${v}`));
  isoSel.addEventListener('change', () => { state.post = { ...state.post, iso: parseInt(isoSel.value, 10) }; hooks.post(); });
  const lutName = el('span', { class: 'val' });
  const lutFile = el<HTMLInputElement>('input', { type: 'file', accept: '.cube' });
  lutFile.addEventListener('change', async () => {
    const f = lutFile.files?.[0];
    if (!f) return;
    try {
      hooks.lut(parseCube(await f.text()));
      state.lutName = f.name;
    } catch (e) {
      hooks.lut(null);
      state.lutName = '';
      lutName.textContent = `erreur : ${(e as Error).message}`;
      return;
    }
    sync();
    hooks.post();
  });
  const lutClear = el<HTMLButtonElement>('button', { type: 'button' }, 'Retirer le look');
  lutClear.addEventListener('click', () => { hooks.lut(null); state.lutName = ''; lutFile.value = ''; sync(); hooks.post(); });
  const film = [
    field2('Émulsion', stockSel),
    field2('Tone mapping (sans émulsion)', toneSel),
    post('Exposition (EV)', 'exposureEv', -4, 4, 0.1),
    post('Gain hautes lumières', 'highlightGain', 1, 8, 0.1, (v) => `×${v.toFixed(1)}`),
    post('Bloom', 'bloom', 0, 1, 0.01),
    post('Bloom : seuil', 'bloomThreshold', 0.2, 4, 0.05),
    post('Bloom : étendue', 'bloomRadius', 0.3, 0.8, 0.01),
    post('Halation', 'halation', 0, 1, 0.01),
    post('Halation : seuil', 'halationThreshold', 0.5, 3, 0.05),
    post('Vignettage naturel (cos⁴)', 'vignetteNatural', 0, 1, 0.01),
    post('Vignettage optique', 'vignetteOptical', 0, 1, 0.01),
    post('Distorsion (+ barillet, − coussinet)', 'distortion', -0.3, 0.3, 0.005),
    post('Aberration chromatique', 'chromaticAberration', 0, 1, 0.01),
    field2('Bruit capteur', isoSel),
    post('Grain', 'grain', 0, 1, 0.01),
    post('Taille du grain (px)', 'grainSize', 0.8, 4, 0.1),
  ];
  const lutRow = el('div', { class: 'field' });
  lutRow.append(el('span', {}, 'Look (.cube)'), lutName, lutFile, el('span', {}, 'Entrée attendue par la LUT'), lutInputSel, lutClear);
  const lutAmount = post('Intensité du look', 'lutAmount', 0, 1, 0.01);
  const title = (t: string) => el('div', { class: 'sep' }, t);

  const readout = el('div', { class: 'readout' });

  const field = (label: string, ...inputs: HTMLElement[]) => {
    const row = el('label', { class: 'field' });
    row.append(el('span', {}, label), ...inputs);
    return row;
  };
  root.append(
    modeRow,
    field('Capteur', sensor),
    field('Focale (mm)', focalRange, focalNum),
    field('Ouverture', fnum),
    field('Mise au point (m)', focus),
    labelled('Bague de map', ringVal, ring),
    marks,
    labelled('Zoom (échelle log)', zoomVal, zoomLog),
    field('Échelle (m / unité)', scale),
    field('Échantillons (cible)', samples),
    title('Objectif'),
    field('Preset', preset),
    ...bokeh,
    title('Shift'),
    ...shift,
    title('Tilt (Scheimpflug)'),
    ...tilt,
    title('Obturateur et défauts'),
    field('Cadence', fpsSel),
    ...shutter,
    title('Optique et pellicule'),
    ...film,
    lutRow,
    lutAmount,
    readout,
  );

  function sync() {
    for (const b of modeBtns) b.classList.toggle('on', b.dataset.mode === state.mode);
    sensor.value = state.sensorId;
    focalNum.value = String(state.focal);
    focalRange.value = String(Math.min(300, state.focal));
    scale.value = String(state.metersPerUnit);
    fnum.value = String(state.fNumber);
    focus.value = String(+state.focusM.toFixed(3));
    samples.value = String(state.samples);
    fpsSel.value = String(state.fps);
    toneSel.value = state.post.toneMap;
    stockSel.value = state.post.stock;
    lutInputSel.value = state.post.lutInput;
    isoSel.value = String(state.post.iso);
    lutName.textContent = state.lutName || 'aucun';
    ring.value = String(dioptersFromMeters(state.focusM));
    ringVal.textContent = state.focusM >= 500 ? '∞' : `${state.focusM.toFixed(2)} m`;
    zoomLog.value = String(zoomFromFocal(Math.min(Math.max(state.focal, 4), 300)));
    zoomVal.textContent = `${state.focal} mm`;
    preset.value = state.presetId;
    for (const f of syncers) f();
    root.classList.toggle('exploring', state.mode === 'explore');
  }
  sync();

  return {
    sync,
    show(fov, targetDistM, extra = '') {
      const d = (r: number) => `${rad2deg(r).toFixed(1)}°`;
      readout.textContent = `FOV  H ${d(fov.h)} · V ${d(fov.v)} · D ${d(fov.d)}\nCible à ${targetDistM.toFixed(2)} m${extra ? '\n' + extra : ''}`;
    },
  };
}
