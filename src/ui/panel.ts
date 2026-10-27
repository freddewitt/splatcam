import { rad2deg, SENSOR_FORMATS, type Fov } from '../optics/sensor';
import type { ApertureShape } from '../optics/aperture';
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
export function createPanel(state: PanelState, onChange: () => void): Panel {
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
  const slider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt = (v: number) => String(+v.toFixed(2))) => {
    const range = el<HTMLInputElement>('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
    const val = el('b', { class: 'val' });
    const upd = () => { range.value = String(get()); val.textContent = fmt(get()); };
    range.addEventListener('input', () => {
      set(parseFloat(range.value));
      state.presetId = ''; preset.value = '';
      upd();
      onChange();
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
    field('Échelle (m / unité)', scale),
    field('Échantillons (cible)', samples),
    title('Objectif'),
    field('Preset', preset),
    ...bokeh,
    title('Shift'),
    ...shift,
    title('Tilt (Scheimpflug)'),
    ...tilt,
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
