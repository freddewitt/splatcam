// Interface de timeline : transport, feuille de clés (dope sheet) et éditeur de courbes à poignées bézier.
// Une seule zone de dessin (canvas 2D) avec deux vues qui partagent l'axe du temps.

import { autoHandle, segmentControls, type Key } from '../timeline/curve';
import { TimelineController } from '../timeline/controller';
import {
  CAMERA_TRACKS, FOCUS_MARKS, TRACK_IDS, dioptersFromMeters, focalFromZoom, metersFromDiopters, zoomFromFocal, type TrackId,
} from '../timeline/shot';

type View = 'sheet' | 'curves';

const LABELS: Record<TrackId, string> = { x: 'Pos. X', y: 'Pos. Y', z: 'Pos. Z', pan: 'Pan', tilt: 'Tilt', roll: 'Roll', focus: 'Map', zoom: 'Zoom' };
const LABEL_W = 118, RULER_H = 22, ROW_H = 24, RIGHT_PAD = 14;
/** Cadence de calage des clés déplacées à la souris (25 i/s, cadence par défaut de l'export). */
const SNAP = 1 / 25;
const FOCAL_MARKS = [12, 16, 24, 35, 50, 85, 135, 200, 300];
/** Étendue verticale minimale (unité de la piste) pour qu'une courbe plate reste lisible. */
const MIN_SPAN: Record<TrackId, number> = { x: 1, y: 1, z: 1, pan: 20, tilt: 20, roll: 20, focus: 0.5, zoom: 0.3 };

const el = <T extends HTMLElement>(tag: string, attrs: Record<string, string> = {}, text = ''): T => {
  const e = document.createElement(tag) as T;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.textContent = text;
  return e;
};

/** Valeur d'une piste, en texte lisible (mètres, mm, degrés). */
export function formatValue(id: TrackId, v: number): string {
  if (id === 'focus') return v < 1 / 500 ? '∞' : `${metersFromDiopters(v).toFixed(2)} m`;
  if (id === 'zoom') return `${focalFromZoom(v).toFixed(0)} mm`;
  if (id === 'pan' || id === 'tilt' || id === 'roll') return `${v.toFixed(1)}°`;
  return v.toFixed(2);
}

type Drag =
  | { kind: 'scrub' }
  | { kind: 'key'; track: TrackId; index: number }
  | { kind: 'handle'; track: TrackId; index: number; side: 'in' | 'out' };

export function createTimelineUI(root: HTMLElement, ctl: TimelineController): { redraw(): void } {
  let view: View = 'sheet';
  let collapsed = false;
  let drag: Drag | null = null;

  const btn = (label: string, title: string, onClick: () => void) => {
    const b = el<HTMLButtonElement>('button', { title, type: 'button' }, label);
    b.addEventListener('click', onClick);
    return b;
  };
  const playBtn = btn('▶', 'Lecture / pause (espace)', () => (ctl.playing ? ctl.pause() : ctl.play()));
  const toStart = btn('⏮', 'Retour au début', () => { ctl.pause(); ctl.seek(0); });
  const loopBtn = btn('Boucle', 'Lecture en boucle', () => ctl.setLoop(!ctl.shot.loop));
  const recBtn = btn('● REC', 'Enregistrement : bouger la caméra, la map ou le zoom pose des clés', () => ctl.toggleRecord());
  const time = el('span', { class: 'time' });
  const dur = el<HTMLInputElement>('input', { type: 'number', min: '0.1', step: '0.5', title: 'Durée du plan (s)' });
  dur.addEventListener('input', () => { const v = parseFloat(dur.value); if (Number.isFinite(v) && v > 0) ctl.setDuration(v); });
  const keyCam = btn('+ Clé caméra', 'Clé sur les 6 pistes caméra à la tête de lecture', () => ctl.keyNow(CAMERA_TRACKS));
  const keyFocus = btn('+ Clé map', 'Clé de mise au point', () => ctl.keyNow(['focus']));
  const keyZoom = btn('+ Clé zoom', 'Clé de focale', () => ctl.keyNow(['zoom']));
  const del = btn('Suppr.', 'Supprime la clé sélectionnée (Suppr)', () => ctl.deleteSelected());
  const tabSheet = btn('Feuille', 'Feuille de clés', () => { view = 'sheet'; redraw(); });
  const tabCurves = btn('Courbes', 'Éditeur de courbes bézier', () => { view = 'curves'; redraw(); });
  const fold = btn('▾', 'Replier / déplier', () => { collapsed = !collapsed; redraw(); });

  const modeBar = el('div', { class: 'row modebar' });
  const modeBtns: [string, string, (k: Key) => void][] = [
    ['Bézier', 'Interpolation lissée à poignées', (k) => { k.mode = 'bezier'; }],
    ['Linéaire', 'Droite vers la clé suivante', (k) => { k.mode = 'linear'; }],
    ['Palier', 'Valeur tenue jusqu\'à la clé suivante', (k) => { k.mode = 'hold'; }],
    ['Auto', 'Poignées automatiques (lissage sans dépassement)', (k) => { k.auto = true; }],
  ];
  const keyReadout = el('span', { class: 'time' });
  for (const [label, title, apply] of modeBtns) {
    modeBar.append(btn(label, title, () => {
      const s = ctl.selection;
      if (!s) return;
      const keys = ctl.shot.tracks[s.track].keys;
      apply(keys[s.key]);
      keys.forEach((_, i) => autoHandle(keys, i));
      ctl.curveEdited();
    }));
  }
  modeBar.append(keyReadout);

  const head = el('div', { class: 'row head' });
  head.append(toStart, playBtn, loopBtn, recBtn, time, el('span', {}, 'Durée'), dur, keyCam, keyFocus, keyZoom, del, tabSheet, tabCurves, fold);
  const canvas = el<HTMLCanvasElement>('canvas');
  root.append(head, canvas, modeBar);
  const g = canvas.getContext('2d')!;

  // --- repères temps / valeur ---
  const W = () => canvas.clientWidth, H = () => canvas.clientHeight;
  const tx = (t: number) => LABEL_W + (t / ctl.shot.duration) * (W() - LABEL_W - RIGHT_PAD);
  const xt = (x: number) => ((x - LABEL_W) / (W() - LABEL_W - RIGHT_PAD)) * ctl.shot.duration;
  const clampT = (t: number) => Math.min(Math.max(t, 0), ctl.shot.duration);
  const snap = (t: number) => clampT(Math.round(t / SNAP) * SNAP);

  // Étendue verticale de la vue courbes : valeurs de la courbe, clés et poignées, avec marge.
  let vMin = 0, vMax = 1;
  function fitValues(id: TrackId): void {
    const keys = ctl.shot.tracks[id].keys;
    if (!keys.length) { vMin = 0; vMax = MIN_SPAN[id]; return; }
    let lo = Infinity, hi = -Infinity;
    for (let px = 0; px <= 200; px++) {
      const v = ctl.valueAt(id, (px / 200) * ctl.shot.duration)!;
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    for (const k of keys) { lo = Math.min(lo, k.v); hi = Math.max(hi, k.v); }
    const span = Math.max(hi - lo, MIN_SPAN[id]), mid = (hi + lo) / 2;
    vMin = mid - span * 0.6; vMax = mid + span * 0.6;
  }
  const area = () => ({ y0: RULER_H + 6, y1: H() - 8 });
  const vy = (v: number) => { const a = area(); return a.y1 - ((v - vMin) / (vMax - vMin)) * (a.y1 - a.y0); };
  const yv = (y: number) => { const a = area(); return vMin + ((a.y1 - y) / (a.y1 - a.y0)) * (vMax - vMin); };

  // --- dessin ---
  const C = { bg: '#0c0c0e', row: '#16171b', grid: '#2a2c33', text: '#9aa', hi: '#79c', key: '#e8c36a', keySel: '#fff', head: '#ff5a4d', curve: '#6fd0a0', handle: '#8ab' };

  function drawRuler(): void {
    g.fillStyle = C.row; g.fillRect(0, 0, W(), RULER_H);
    g.fillStyle = C.text; g.font = '10px ui-monospace, Menlo, monospace'; g.textBaseline = 'middle';
    const D = ctl.shot.duration;
    const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60].find((s) => (s / D) * (W() - LABEL_W) >= 46) ?? 60;
    for (let t = 0; t <= D + 1e-6; t += step) {
      g.fillRect(tx(t), RULER_H - 6, 1, 6);
      g.fillText(`${+t.toFixed(2)}s`, tx(t) + 3, RULER_H / 2 - 2);
    }
  }

  function drawPlayhead(): void {
    const x = tx(ctl.time);
    g.fillStyle = C.head; g.fillRect(x - 0.5, 0, 1.5, H());
    g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 7); g.closePath(); g.fill();
  }

  const diamond = (x: number, y: number, r: number, fill: string) => {
    g.fillStyle = fill; g.beginPath();
    g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); g.fill();
  };

  function drawSheet(): void {
    TRACK_IDS.forEach((id, row) => {
      const y = RULER_H + row * ROW_H;
      g.fillStyle = id === ctl.curveTrack ? '#1d2230' : row % 2 ? C.bg : C.row;
      g.fillRect(0, y, W(), ROW_H);
      g.fillStyle = C.text; g.font = '11px ui-monospace, Menlo, monospace'; g.textBaseline = 'middle';
      g.fillText(LABELS[id], 8, y + ROW_H / 2);
      const v = ctl.valueAt(id, ctl.time);
      if (v !== undefined) { g.fillStyle = C.hi; g.fillText(formatValue(id, v), 74, y + ROW_H / 2); }
      ctl.shot.tracks[id].keys.forEach((k, i) => {
        const sel = ctl.selection?.track === id && ctl.selection.key === i;
        diamond(tx(k.t), y + ROW_H / 2, sel ? 6 : 5, sel ? C.keySel : C.key);
      });
    });
  }

  function drawYAxis(id: TrackId): void {
    g.font = '10px ui-monospace, Menlo, monospace'; g.textBaseline = 'middle'; g.textAlign = 'right';
    const ticks: [number, string][] = [];
    if (id === 'focus') { // repères de la bague de map, espacés en dioptries
      for (const m of FOCUS_MARKS) { const d = Number.isFinite(m) ? 1 / m : 0; if (d >= vMin && d <= vMax) ticks.push([d, Number.isFinite(m) ? `${m} m` : '∞']); }
    } else if (id === 'zoom') { // repères de focale, espacés en log
      for (const f of FOCAL_MARKS) { const z = zoomFromFocal(f); if (z >= vMin && z <= vMax) ticks.push([z, `${f} mm`]); }
    } else {
      const raw = (vMax - vMin) / 5, p = Math.pow(10, Math.floor(Math.log10(raw)));
      const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
      for (let v = Math.ceil(vMin / step) * step; v <= vMax; v += step) ticks.push([v, formatValue(id, v)]);
    }
    for (const [v, label] of ticks) {
      const y = vy(v);
      g.fillStyle = C.grid; g.fillRect(LABEL_W - 4, y, W() - LABEL_W - RIGHT_PAD + 4, 1);
      g.fillStyle = C.text; g.fillText(label, LABEL_W - 8, y);
    }
    g.textAlign = 'left';
  }

  /** Positions écran des poignées de la clé sélectionnée (celles réellement utilisées : bornées au segment). */
  function handlePoints(id: TrackId, i: number): { in?: [number, number]; out?: [number, number] } {
    const keys = ctl.shot.tracks[id].keys;
    const out: { in?: [number, number]; out?: [number, number] } = {};
    if (keys[i].mode === 'bezier' && keys[i + 1]) { const p = segmentControls(keys[i], keys[i + 1])[1]; out.out = [tx(p[0]), vy(p[1])]; }
    if (keys[i - 1]?.mode === 'bezier') { const p = segmentControls(keys[i - 1], keys[i])[2]; out.in = [tx(p[0]), vy(p[1])]; }
    return out;
  }

  function drawCurves(): void {
    const id = ctl.curveTrack, keys = ctl.shot.tracks[id].keys;
    g.fillStyle = C.bg; g.fillRect(0, RULER_H, W(), H() - RULER_H);
    g.fillStyle = C.text; g.font = '11px ui-monospace, Menlo, monospace'; g.textBaseline = 'middle';
    g.fillText(LABELS[id], 8, RULER_H + 12);
    if (!keys.length) { g.fillText('Aucune clé : double-clic pour en poser une', LABEL_W + 12, RULER_H + 28); return; }
    fitValues(id);
    drawYAxis(id);
    g.strokeStyle = C.curve; g.lineWidth = 1.5; g.beginPath();
    const n = Math.max(2, Math.floor(W() - LABEL_W));
    for (let px = 0; px <= n; px++) {
      const t = (px / n) * ctl.shot.duration, v = ctl.valueAt(id, t)!;
      if (px === 0) g.moveTo(tx(t), vy(v)); else g.lineTo(tx(t), vy(v));
    }
    g.stroke();
    const sel = ctl.selection?.track === id ? ctl.selection.key : -1;
    if (sel >= 0) {
      const k = keys[sel], hp = handlePoints(id, sel);
      g.strokeStyle = C.handle; g.lineWidth = 1;
      for (const h of [hp.in, hp.out]) {
        if (!h) continue;
        g.beginPath(); g.moveTo(tx(k.t), vy(k.v)); g.lineTo(h[0], h[1]); g.stroke();
        g.fillStyle = C.handle; g.fillRect(h[0] - 4, h[1] - 4, 8, 8);
      }
    }
    keys.forEach((k, i) => {
      g.fillStyle = i === sel ? C.keySel : C.key;
      g.beginPath(); g.arc(tx(k.t), vy(k.v), i === sel ? 6 : 5, 0, Math.PI * 2); g.fill();
    });
  }

  function redraw(): void {
    root.classList.toggle('collapsed', collapsed);
    canvas.style.display = collapsed ? 'none' : '';
    modeBar.style.display = collapsed || view !== 'curves' || !ctl.selection ? 'none' : '';
    playBtn.textContent = ctl.playing ? '⏸' : '▶';
    loopBtn.classList.toggle('on', ctl.shot.loop);
    recBtn.classList.toggle('rec', ctl.recording);
    tabSheet.classList.toggle('on', view === 'sheet');
    tabCurves.classList.toggle('on', view === 'curves');
    time.textContent = `${ctl.time.toFixed(2)} s`;
    if (document.activeElement !== dur) dur.value = String(ctl.shot.duration);
    const s = ctl.selection;
    const sk = s ? ctl.shot.tracks[s.track].keys[s.key] : undefined;
    keyReadout.textContent = sk && s ? `${LABELS[s.track]} · ${sk.t.toFixed(2)} s · ${formatValue(s.track, sk.v)} · ${sk.mode}${sk.auto ? ' · auto' : ''}` : '';
    if (collapsed) return;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(W() * dpr), h = Math.round(H() * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg; g.fillRect(0, 0, W(), H());
    drawRuler();
    if (view === 'sheet') drawSheet(); else drawCurves();
    drawPlayhead();
  }

  // --- interactions ---
  const local = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const near = (a: number, b: number, c: number, d: number, r: number) => Math.hypot(a - c, b - d) <= r;

  function hit(x: number, y: number): Drag | { kind: 'row'; track: TrackId } | null {
    if (y < RULER_H) return { kind: 'scrub' };
    if (view === 'sheet') {
      const row = Math.floor((y - RULER_H) / ROW_H);
      const id = TRACK_IDS[row];
      if (!id) return null;
      const ky = RULER_H + row * ROW_H + ROW_H / 2;
      const keys = ctl.shot.tracks[id].keys;
      for (let i = keys.length - 1; i >= 0; i--) if (near(x, y, tx(keys[i].t), ky, 9)) return { kind: 'key', track: id, index: i };
      return { kind: 'row', track: id };
    }
    const id = ctl.curveTrack, keys = ctl.shot.tracks[id].keys;
    const s = ctl.selection?.track === id ? ctl.selection.key : -1;
    if (s >= 0) {
      const hp = handlePoints(id, s);
      if (hp.out && near(x, y, hp.out[0], hp.out[1], 9)) return { kind: 'handle', track: id, index: s, side: 'out' };
      if (hp.in && near(x, y, hp.in[0], hp.in[1], 9)) return { kind: 'handle', track: id, index: s, side: 'in' };
    }
    for (let i = keys.length - 1; i >= 0; i--) if (near(x, y, tx(keys[i].t), vy(keys[i].v), 10)) return { kind: 'key', track: id, index: i };
    return { kind: 'row', track: id };
  }

  canvas.addEventListener('pointerdown', (e) => {
    const { x, y } = local(e);
    const h = hit(x, y);
    if (!h) return;
    canvas.setPointerCapture(e.pointerId);
    if (h.kind === 'scrub') { drag = h; ctl.pause(); ctl.seek(snap(xt(x))); return; }
    if (h.kind === 'row') { ctl.curveTrack = h.track; ctl.selection = null; ctl.emit(); return; }
    drag = h;
    ctl.curveTrack = h.track;
    ctl.selection = { track: h.track, key: h.index };
    ctl.emit();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const { x, y } = local(e);
    if (drag.kind === 'scrub') { ctl.seek(snap(xt(x))); return; }
    const keys = ctl.shot.tracks[drag.track].keys, k = keys[drag.index];
    if (drag.kind === 'key') {
      ctl.moveKeyTo(drag.track, drag.index, snap(xt(x)), view === 'curves' ? yv(y) : k.v);
    } else {
      const t = xt(x), v = yv(y);
      k.auto = false;
      if (drag.side === 'out') k.hout = { dt: Math.max(0, t - k.t), dv: v - k.v };
      else k.hin = { dt: Math.min(0, t - k.t), dv: v - k.v };
      ctl.curveEdited();
    }
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('dblclick', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const h = hit(x, y);
    if (!h || h.kind !== 'row') return;
    const t = snap(xt(x));
    ctl.addKeyAt(h.track, t, view === 'curves' && ctl.shot.tracks[h.track].keys.length ? yv(y) : undefined);
  });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLElement && e.target.matches('input, select, textarea')) return;
    if (e.key === 'Delete' || e.key === 'Backspace') ctl.deleteSelected();
    else if (e.key === ' ') { e.preventDefault(); if (ctl.playing) ctl.pause(); else ctl.play(); }
  });

  new ResizeObserver(() => redraw()).observe(canvas);
  ctl.onChange(redraw);
  redraw();
  return { redraw };
}
