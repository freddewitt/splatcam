// Fenêtre d'export : résolution, échantillons, image seule ou plan entier, dossier ou ZIP, progression, annulation.

import { frameCount, exportSize } from '../export/sequence';
import { hasFolderPicker, pickFolderSink, zipSink, type Sink } from '../export/sinks';
import type { ExportEnd, ExportJob, ExportProgress, Exporter } from '../export/exporter';

export interface ExportUiContext {
  /** Rapport du capteur courant, cadence, durée du plan, image courante (base 0), échantillons de l'état, limite de texture. */
  info(): { aspect: number; fps: number; duration: number; currentFrame: number; samples: number; maxDim: number };
  exporter(): Exporter;
}

const el = <T extends HTMLElement>(tag: string, attrs: Record<string, string> = {}, text = ''): T => {
  const e = document.createElement(tag) as T;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.textContent = text;
  return e;
};

const HEIGHTS = [720, 1080, 1440, 2160, 2880];

export function createExportUi(root: HTMLElement, ctx: ExportUiContext): { setProgress(p: ExportProgress): void } {
  const open = el<HTMLButtonElement>('button', { class: 'open' }, 'Export…');
  const card = el('div', { class: 'card' });
  const box = el('div', { class: 'box hidden' });
  box.append(card);
  root.append(open, box);

  const field = (label: string, input: HTMLElement) => {
    const f = el('label', { class: 'field' });
    f.append(el('span', {}, label), input);
    return f;
  };
  const height = el<HTMLSelectElement>('select');
  for (const h of HEIGHTS) height.append(el<HTMLOptionElement>('option', { value: String(h) }, `${h} px de haut`));
  height.value = '1080';
  const samples = el<HTMLInputElement>('input', { type: 'number', min: '1', max: '1024', step: '1' });
  const range = el<HTMLSelectElement>('select');
  range.append(el<HTMLOptionElement>('option', { value: 'shot' }, 'Plan entier (séquence)'), el<HTMLOptionElement>('option', { value: 'frame' }, 'Image courante seule'));
  const dest = el<HTMLSelectElement>('select');
  dest.append(el<HTMLOptionElement>('option', { value: 'folder' }, 'Dossier (écriture image par image)'), el<HTMLOptionElement>('option', { value: 'zip' }, 'Archive ZIP (en mémoire)'));
  if (!hasFolderPicker()) { dest.value = 'zip'; dest.options[0].disabled = true; }
  const resume = el<HTMLInputElement>('input', { type: 'checkbox' });
  const resumeRow = el('label', { class: 'check' });
  resumeRow.append(resume, document.createTextNode(' Reprendre : sauter les images déjà écrites dans le dossier'));
  const summary = el('div', { class: 'readout' });
  const bar = el<HTMLProgressElement>('progress', { max: '1', value: '0' });
  const status = el('div', { class: 'status' });
  const start = el<HTMLButtonElement>('button', { class: 'go' }, 'Lancer');
  const cancel = el<HTMLButtonElement>('button', {}, 'Annuler');
  const close = el<HTMLButtonElement>('button', {}, 'Fermer');
  const buttons = el('div', { class: 'row' });
  buttons.append(start, cancel, close);
  card.append(
    el('h3', {}, 'Export PNG 16 bits'),
    field('Résolution (rapport du capteur)', height), field('Échantillons par image', samples),
    field('Contenu', range), field('Destination', dest), resumeRow, summary, bar, status, buttons,
  );
  const note = el('div', { class: 'status' }, 'PNG RGB 16 bits (sRGB), master pour le montage et l\'étalonnage. Les réglages sont écrits à côté dans shot_export.json.');
  card.insertBefore(note, summary);

  const job = (): ExportJob & { size: { w: number; h: number } } => {
    const i = ctx.info();
    const size = exportSize(parseInt(height.value, 10), i.aspect, i.maxDim);
    const total = frameCount(i.duration, i.fps);
    const frames = range.value === 'frame' ? [Math.min(i.currentFrame, total - 1)] : Array.from({ length: total }, (_, k) => k);
    return { width: size.w, height: size.h, samples: Math.max(1, Math.min(1024, parseInt(samples.value, 10) || 1)), fps: i.fps, frames, total, resume: resume.checked && dest.value === 'folder', size };
  };

  const refresh = () => {
    const j = job();
    const mb = (j.width * j.height * 16 * 3) / 1048576;     // 2 accumulateurs RGBA32F + cible de sortie, hors post-traitement
    summary.textContent = `${j.width}×${j.height} · ${j.frames.length} image(s) · ${j.samples} éch.\nMémoire GPU ≥ ${mb.toFixed(0)} Mo (+ post-traitement)`;
    resume.disabled = dest.value !== 'folder';
  };
  for (const e of [height, samples, range, dest, resume]) e.addEventListener('input', refresh);

  const busy = (on: boolean) => {
    for (const e of [height, samples, range, dest, resume, start, close]) (e as HTMLInputElement).disabled = on;
    cancel.disabled = !on;
    if (!on) refresh();
  };

  open.addEventListener('click', () => { samples.value = String(ctx.info().samples); bar.value = 0; status.textContent = ''; busy(false); refresh(); box.classList.remove('hidden'); });
  close.addEventListener('click', () => box.classList.add('hidden'));
  cancel.addEventListener('click', () => ctx.exporter().cancel());

  start.addEventListener('click', async () => {
    const j = job();
    // Le sélecteur de dossier exige un geste utilisateur : il passe avant tout autre await.
    let sink: Sink | null;
    try { sink = dest.value === 'folder' ? await pickFolderSink() : zipSink(); } catch (e) { status.textContent = `Dossier inaccessible : ${(e as Error).message}`; return; }
    if (!sink) return;
    busy(true);
    status.textContent = 'Rendu…';
    const end: ExportEnd = await ctx.exporter().start(j, sink);
    status.textContent = end.message;
    status.classList.toggle('err', !end.ok && !end.cancelled);
    busy(false);
  });

  return {
    setProgress(p) {
      bar.max = p.count; bar.value = p.done + p.sample / p.samples;
      status.textContent = `Image ${p.frame + 1} · ${p.done}/${p.count} terminées · ${p.sample}/${p.samples} éch.`;
    },
  };
}
