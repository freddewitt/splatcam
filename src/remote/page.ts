// Page de télécommande (ouverte sur le téléphone) : transport du plan, objectif, mise au point.
// L'application sur le Mac fait le rendu ; cette page n'envoie que des commandes (protocol.ts) et affiche l'état.

import { FOCUS_FAR_M, FOCUS_MIN_M, dioptersFromMeters, focalFromZoom, metersFromDiopters, zoomFromFocal } from '../timeline/shot';
import type { Command, RelayMessage, RemoteState } from './protocol';

const token = new URLSearchParams(location.search).get('t') ?? '';
const app = document.getElementById('app')!;
const dot = document.getElementById('dot')!;
const statusEl = document.getElementById('status')!;
const msg = document.getElementById('msg')!;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.textContent = text;
  return e;
};

async function send(c: Command) {
  try {
    const r = await fetch(`/relay/cmd?t=${encodeURIComponent(token)}`, { method: 'POST', body: JSON.stringify(c) });
    msg.textContent = r.status === 503 ? 'L\'application n\'est pas ouverte sur le Mac.' : r.ok ? '' : `Refusé (${r.status}) : lien périmé ? Rouvrir l'adresse affichée sur le Mac.`;
  } catch { msg.textContent = 'Réseau injoignable.'; }
}

/** Envoi limité à ~20/s pour les curseurs ; la dernière valeur part toujours. */
function throttled(fn: (v: number) => void, ms = 50) {
  let last = 0, timer = 0, pending = 0;
  return (v: number) => {
    pending = v;
    const wait = last + ms - performance.now();
    if (wait <= 0) { last = performance.now(); fn(v); return; }
    clearTimeout(timer);
    timer = window.setTimeout(() => { last = performance.now(); fn(pending); }, wait);
  };
}

const btn = (label: string, c: Command | (() => Command), cls = '') => {
  const b = el('button', { type: 'button', class: cls }, label);
  b.addEventListener('click', () => void send(typeof c === 'function' ? c() : c));
  return b;
};
const section = (title: string, ...kids: HTMLElement[]) => { const s = el('section'); s.append(el('div', { class: 'title' }, title), ...kids); return s; };
const row = (...kids: HTMLElement[]) => { const r = el('div', { class: 'row' }); r.append(...kids); return r; };
const read = (label: string) => { const r = el('div', { class: 'read' }); const v = el('b'); r.append(el('span', {}, label), v); return { r, v }; };

/** Curseur qui n'est pas écrasé par l'état reçu tant que le doigt est dessus. */
function slider(min: number, max: number, step: number, onInput: (v: number) => void) {
  const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
  let down = false;
  const send = throttled(onInput);
  input.addEventListener('pointerdown', () => { down = true; });
  // pointercancel : le geste a été repris par le défilement (tactile) ; sans lui, le curseur ne suivrait plus le Mac.
  for (const t of ['pointerup', 'pointercancel']) addEventListener(t, () => { down = false; });
  input.addEventListener('input', () => send(parseFloat(input.value)));
  return { input, set: (v: number) => { if (!down) input.value = String(v); } };
}

// Transport
const time = read('Temps');
const seek = slider(0, 5, 0.01, (t) => void send({ cmd: 'seek', t }));
const play = btn('▶', { cmd: 'toggle' }, 'big');
const rec = btn('● REC', { cmd: 'rec' }, 'rec');
const loop = btn('Boucle', { cmd: 'loop' });
// Objectif
const focalRead = read('Focale');
const zoom = slider(zoomFromFocal(4), zoomFromFocal(300), 0.001, (z) => void send({ cmd: 'focal', value: Math.round(focalFromZoom(z) * 10) / 10 }));
const fRead = read('Ouverture');
const focusRead = read('Mise au point');
const focus = slider(1 / FOCUS_FAR_M, 1 / FOCUS_MIN_M, 0.001, (d) => void send({ cmd: 'focus', meters: metersFromDiopters(d) }));
const modeBtns = (['explore', 'shoot'] as const).map((m) => { const b = btn(m === 'explore' ? 'Exploration' : 'Tournage', { cmd: 'mode', mode: m }); b.dataset.mode = m; return b; });

app.append(
  section('Plan', row(...modeBtns), time.r, seek.input,
    row(btn('⏮', { cmd: 'home' }), btn('◀ image', { cmd: 'step', frames: -1 }), play, btn('image ▶', { cmd: 'step', frames: 1 }), btn('⏭', { cmd: 'end' })),
    row(rec, loop),
    row(btn('◆ Clé tout', { cmd: 'key', scope: 'all' }), btn('◇ Clé caméra', { cmd: 'key', scope: 'camera' }))),
  section('Objectif', focalRead.r, zoom.input, fRead.r,
    row(btn('− 1/3', { cmd: 'fstop', thirds: -1 }), btn('+ 1/3', { cmd: 'fstop', thirds: 1 })),
    focusRead.r, focus.input),
);
app.style.display = 'grid'; app.style.gap = '14px';

function show(s: RemoteState) {
  time.v.textContent = `${s.time.toFixed(2)} / ${s.duration.toFixed(2)} s`;
  seek.input.max = String(s.duration);
  seek.set(s.time);
  play.textContent = s.playing ? '⏸' : '▶';
  rec.classList.toggle('on', s.recording);
  loop.classList.toggle('on', s.loop);
  for (const b of modeBtns) b.classList.toggle('on', b.dataset.mode === s.mode);
  focalRead.v.textContent = `${s.focal} mm`;
  zoom.set(zoomFromFocal(Math.min(Math.max(s.focal, 4), 300)));
  fRead.v.textContent = `f/${s.fNumber}`;
  focusRead.v.textContent = s.focusM >= 500 ? '∞' : `${s.focusM.toFixed(2)} m`;
  focus.set(dioptersFromMeters(s.focusM));
}

function setOnline(on: boolean) {
  dot.classList.toggle('on', on);
  statusEl.textContent = on ? 'Connecté au Mac' : 'Application hors ligne sur le Mac';
  app.classList.toggle('offline', !on);
}

if (!token) { statusEl.textContent = 'Lien incomplet : rouvrir l\'adresse affichée sur le Mac.'; }
else {
  const es = new EventSource(`/relay/events?role=phone&t=${encodeURIComponent(token)}`);
  es.onmessage = (e) => {
    const m = JSON.parse(e.data) as RelayMessage;
    if (m.type === 'state') show(m.state);
    else if (m.type === 'mac') setOnline(m.online);
  };
  es.onerror = () => setOnline(false);
}
