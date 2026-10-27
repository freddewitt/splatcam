import { rad2deg, SENSOR_FORMATS, type Fov } from '../optics/sensor';

export type Mode = 'explore' | 'shoot';

export interface PanelState {
  mode: Mode;
  sensorId: string;
  focal: number;
  metersPerUnit: number;
}

export interface Panel {
  /** Met à jour les valeurs affichées (FOV, distance à la cible). */
  show(fov: Fov, targetDistM: number): void;
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
    field('Échelle (m / unité)', scale),
    readout,
  );

  function sync() {
    for (const b of modeBtns) b.classList.toggle('on', b.dataset.mode === state.mode);
    sensor.value = state.sensorId;
    focalNum.value = String(state.focal);
    focalRange.value = String(Math.min(300, state.focal));
    scale.value = String(state.metersPerUnit);
    root.classList.toggle('exploring', state.mode === 'explore');
  }
  sync();

  return {
    sync,
    show(fov, targetDistM) {
      const d = (r: number) => `${rad2deg(r).toFixed(1)}°`;
      readout.textContent = `FOV  H ${d(fov.h)} · V ${d(fov.v)} · D ${d(fov.d)}\nCible à ${targetDistM.toFixed(2)} m`;
    },
  };
}
