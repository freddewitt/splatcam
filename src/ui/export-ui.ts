// Fenêtre d'export : PNG 16 bits (master) ou aperçu MP4 8 bits ; résolution, échantillons, destination, progression,
// annulation ; commandes ffmpeg de finition à la fin d'une séquence PNG.

import { frameCount, exportSize } from '../export/sequence';
import { downloadSink, hasFolderPicker, pickFolderSink, zipSink, type Sink } from '../export/sinks';
import { pngWriter, mp4Writer } from '../export/writers';
import { Mp4Encoder, MP4_CODECS, encodableCodecs } from '../export/mp4';
import { defaultBitrateMbps, ffmpegCommands } from '../export/video-plan';
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
  const open = el<HTMLButtonElement>('button', { class: 'open', type: 'button', title: 'Exporter le plan (X)' }, 'Exporter');
  const card = el('div', { class: 'card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Export' });
  const box = el('div', { class: 'box hidden' });
  box.append(card);
  root.append(open, box);

  const field = (label: string, input: HTMLElement) => {
    const f = el('label', { class: 'field' });
    f.append(el('span', {}, label), input);
    return f;
  };
  const opt = (value: string, text: string) => el<HTMLOptionElement>('option', { value }, text);
  const format = el<HTMLSelectElement>('select');
  format.append(opt('png', 'PNG 16 bits (master)'), opt('mp4', 'Aperçu MP4 (8 bits)'));
  const height = el<HTMLSelectElement>('select');
  for (const h of HEIGHTS) height.append(opt(String(h), `${h} px de haut`));
  height.value = '1080';
  const samples = el<HTMLInputElement>('input', { type: 'number', min: '1', max: '1024', step: '1' });
  const range = el<HTMLSelectElement>('select');
  range.append(opt('shot', 'Plan entier (séquence)'), opt('frame', 'Image courante seule'));
  const codec = el<HTMLSelectElement>('select');
  const bitrate = el<HTMLInputElement>('input', { type: 'number', min: '1', max: '400', step: '0.5' });
  const dest = el<HTMLSelectElement>('select');
  const resume = el<HTMLInputElement>('input', { type: 'checkbox' });
  const resumeRow = el('label', { class: 'check' });
  resumeRow.append(resume, document.createTextNode(' Reprendre : sauter les images déjà écrites dans le dossier'));
  const note = el('div', { class: 'status' });
  const summary = el('div', { class: 'readout' });
  const bar = el<HTMLProgressElement>('progress', { max: '1', value: '0' });
  const status = el('div', { class: 'status' });
  const commands = el('div', { class: 'cmds' });
  const start = el<HTMLButtonElement>('button', { class: 'go' }, 'Lancer');
  const cancel = el<HTMLButtonElement>('button', {}, 'Annuler');
  const close = el<HTMLButtonElement>('button', {}, 'Fermer');
  const buttons = el('div', { class: 'row' });
  buttons.append(start, cancel, close);
  const rangeF = field('Contenu', range), codecF = field('Codec', codec), bitrateF = field('Débit (Mbit/s)', bitrate);
  card.append(
    el('h3', {}, 'Export'), field('Format', format), field('Résolution (rapport du capteur)', height), field('Échantillons par image', samples),
    rangeF, codecF, bitrateF, field('Destination', dest), resumeRow, note, summary, bar, status, commands, buttons,
  );

  const isMp4 = () => format.value === 'mp4';
  const fill = (sel: HTMLSelectElement, items: [string, string][], keep: string) => {
    sel.replaceChildren(...items.map(([v, t]) => opt(v, t)));
    sel.value = items.some(([v]) => v === keep) ? keep : items[0]?.[0] ?? '';
  };

  const job = (): ExportJob & { size: { w: number; h: number }; fps: number } => {
    const i = ctx.info();
    const size = exportSize(parseInt(height.value, 10), i.aspect, i.maxDim);
    const total = frameCount(i.duration, i.fps);
    const single = !isMp4() && range.value === 'frame';
    const frames = single ? [Math.min(i.currentFrame, total - 1)] : Array.from({ length: total }, (_, k) => k);
    return { width: size.w, height: size.h, samples: Math.max(1, Math.min(1024, parseInt(samples.value, 10) || 1)), fps: i.fps, frames, total, resume: !isMp4() && resume.checked && dest.value === 'folder', size };
  };

  // Codecs MP4 réellement encodables (interrogés à l'exécution : dépend de Chrome et de la machine).
  let probe = 0;
  const probeCodecs = async () => {
    const mine = ++probe, j = job();
    const found = await encodableCodecs(j.width, j.height, j.fps, (parseFloat(bitrate.value) || 1) * 1e6);
    if (mine !== probe) return;
    fill(codec, found.map((id) => [id, MP4_CODECS.find((c) => c.id === id)!.label] as [string, string]), codec.value);
    start.disabled = isMp4() && found.length === 0;
    if (isMp4() && found.length === 0) status.textContent = 'Aucun codec MP4 encodable à cette taille dans ce navigateur : essayer une résolution plus basse.';
  };

  const refresh = () => {
    const mp4 = isMp4();
    const keep = dest.value;
    fill(dest, mp4
      ? [...(hasFolderPicker() ? [['folder', 'Dossier'] as [string, string]] : []), ['download', 'Téléchargement']]
      : [...(hasFolderPicker() ? [['folder', 'Dossier (écriture image par image)'] as [string, string]] : []), ['zip', 'Archive ZIP (en mémoire)']], keep);
    rangeF.style.display = mp4 ? 'none' : '';
    codecF.style.display = bitrateF.style.display = mp4 ? '' : 'none';
    resumeRow.style.display = mp4 ? 'none' : '';
    resume.disabled = dest.value !== 'folder';
    note.textContent = mp4
      ? 'Aperçu H.264 8 bits, même rendu déterministe que le PNG. Ce n\'est pas un master : la séquence PNG 16 bits reste la référence pour le montage et l\'étalonnage.'
      : 'PNG RGB 16 bits (sRGB), master pour le montage et l\'étalonnage. Les réglages sont écrits à côté dans shot_export.json ; des commandes ffmpeg de finition sont proposées à la fin.';
    const j = job();
    const mb = (j.width * j.height * 16 * 3) / 1048576;     // 2 accumulateurs RGBA32F + cible de sortie, hors post-traitement
    summary.textContent = `${j.width}×${j.height} · ${j.frames.length} image(s) à ${j.fps} i/s · ${j.samples} éch.\nMémoire GPU ≥ ${mb.toFixed(0)} Mo (+ post-traitement)`;
    if (mp4) void probeCodecs(); else start.disabled = false;
  };
  const refreshBitrate = () => { const j = job(); bitrate.value = String(defaultBitrateMbps(j.width, j.height, j.fps)); refresh(); };
  for (const e of [format, height, range, dest, resume, codec]) e.addEventListener('input', e === height || e === format ? refreshBitrate : refresh);
  for (const e of [samples, bitrate]) e.addEventListener('input', refresh);

  const controls = [format, height, samples, range, codec, bitrate, dest, resume, start, close];
  const busy = (on: boolean) => {
    for (const e of controls) (e as HTMLInputElement).disabled = on;
    cancel.disabled = !on;
    if (!on) refresh();
  };

  open.addEventListener('click', () => {
    samples.value = String(ctx.info().samples); bar.value = 0; status.textContent = ''; commands.replaceChildren();
    busy(false); refreshBitrate(); box.classList.remove('hidden');
  });
  const hide = () => { if (!ctx.exporter().running) { box.classList.add('hidden'); open.focus(); } };
  close.addEventListener('click', hide);
  // Fond cliqué ou Échap : ferme (sauf pendant un export, qui se suit dans cette fenêtre).
  box.addEventListener('click', (e) => { if (e.target === box) hide(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !box.classList.contains('hidden')) hide(); });
  cancel.addEventListener('click', () => ctx.exporter().cancel());

  /** Commandes ffmpeg de finition, prêtes à copier. */
  const showCommands = (fps: number) => {
    commands.replaceChildren(el('div', { class: 'status' }, 'Finition depuis la séquence (à lancer dans le dossier des images) :'));
    for (const c of ffmpegCommands({ fps })) {
      const area = el<HTMLTextAreaElement>('textarea', { readonly: '', rows: '3' });
      area.value = c.command;
      const copy = el<HTMLButtonElement>('button', {}, 'Copier');
      copy.addEventListener('click', () => { void navigator.clipboard.writeText(c.command).then(() => { copy.textContent = 'Copié'; }, () => { area.select(); }); });
      const row = el('div', { class: 'cmd' });
      row.append(el('span', {}, c.label), area, copy);
      commands.append(row);
    }
  };

  start.addEventListener('click', async () => {
    const j = job(), mp4 = isMp4();
    commands.replaceChildren();
    status.classList.remove('err');
    // Le sélecteur de dossier exige un geste utilisateur : il passe avant tout autre await.
    let sink: Sink | null;
    try { sink = dest.value === 'folder' ? await pickFolderSink() : mp4 ? downloadSink() : zipSink(); } catch (e) { status.textContent = `Dossier inaccessible : ${(e as Error).message}`; return; }
    if (!sink) return;
    busy(true);
    status.textContent = 'Rendu…';
    const writer = mp4
      ? mp4Writer(sink, new Mp4Encoder(j.width, j.height, j.fps, codec.value as 'avc' | 'hevc', (parseFloat(bitrate.value) || 1) * 1e6))
      : pngWriter(sink);
    const end: ExportEnd = await ctx.exporter().start(j, writer);
    status.textContent = end.message;
    status.classList.toggle('err', !end.ok && !end.cancelled);
    if (end.ok && !mp4 && end.written > 0 && j.total > 1) showCommands(j.fps);
    busy(false);
  });

  return {
    setProgress(p) {
      bar.max = p.count; bar.value = p.done + p.sample / p.samples;
      status.textContent = `Image ${p.frame + 1} · ${p.done}/${p.count} terminées · ${p.sample}/${p.samples} éch.`;
    },
  };
}
