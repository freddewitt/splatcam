// Export d'une séquence d'images : rend chaque image du plan à la résolution voulue (hors écran, mêmes
// sous-rendus que l'aperçu), la relit en flottant, l'écrit en PNG 16 bits. Piloté par `tick()` depuis la
// boucle de l'application (les sous-rendus ne peuvent se faire que dans un tour de boucle PlayCanvas).
//
// Déterminisme : l'échantillon k d'une image est toujours le même (indice k dans les suites de Halton), le
// bruit capteur / grain est semé par le numéro d'image, la caméra vient du plan à t = i / fps.

import type { DofRenderer } from '../render/dof-renderer';
import type { FrameWriter } from './writers';
import { fingerprint, frameTime, pendingFrames, stableStringify } from './sequence';

/** Ce que l'export demande à l'application (caméra, plan, état à restaurer). */
export interface ExportHost {
  dof: DofRenderer;
  /** Passe en mode tournage, coupe lecture et enregistrement, mémorise l'état à restaurer. */
  prepare(): void;
  /** Place l'application à l'image `index` (instant du plan, graine du bruit). */
  setFrame(index: number, timeS: number): void;
  /** Rétablit l'état d'avant l'export. */
  restore(): void;
  /** Réglages sérialisables de la prise (objectif, post, plan) : empreinte de reprise et sidecar. */
  settings(): unknown;
}

export interface ExportJob {
  width: number;
  height: number;
  samples: number;
  fps: number;
  /** Numéros d'images (base 0) à produire, dans l'ordre. */
  frames: number[];
  /** Total de la séquence (pour la numérotation et l'affichage). */
  total: number;
  /** Sauter les images déjà présentes dans la destination. */
  resume: boolean;
}

export interface ExportProgress {
  /** Images terminées / à produire dans cette passe. */
  done: number;
  count: number;
  /** Image en cours (base 0) et échantillons accumulés. */
  frame: number;
  sample: number;
  samples: number;
}

export type ExportEnd = { ok: true; message: string; written: number } | { ok: false; cancelled: boolean; message: string };

/** Sous-rendus par tour de boucle : assez pour avancer vite, assez peu pour garder l'interface vivante. */
const STEP_SAMPLES = 4;
/** Images au plus pour laisser le tri des splats rattraper la pose d'une image exportée. */
const SETTLE_MAX = 30;

export class Exporter {
  private run: {
    job: ExportJob; writer: FrameWriter; pending: number[]; i: number; started: boolean; settle: number;
    phase: 'render' | 'write'; written: number; cancel: boolean; done: (e: ExportEnd) => void;
  } | null = null;

  constructor(private readonly host: ExportHost, private readonly onProgress: (p: ExportProgress) => void) {}

  get running(): boolean { return this.run !== null; }

  cancel(): void { if (this.run) this.run.cancel = true; }

  /** Lance l'export ; la promesse se résout à la fin (réussie, annulée ou en erreur). */
  async start(job: ExportJob, writer: FrameWriter): Promise<ExportEnd> {
    if (this.run) return { ok: false, cancelled: false, message: 'Un export est déjà en cours.' };
    const key = fingerprint(stableStringify({ settings: this.host.settings(), w: job.width, h: job.height, n: job.samples, fps: job.fps, total: job.total }));
    let pending = job.frames;
    try {
      if (job.resume && writer.resumable) {
        const meta = await writer.readMeta();
        const prev = meta ? (JSON.parse(meta) as { key?: string }).key : undefined;
        const done = await writer.existing();
        if (done.size > 0 && prev !== key) {
          return { ok: false, cancelled: false, message: 'Reprise impossible : les réglages (ou la résolution, les échantillons, le plan) ont changé depuis les images déjà écrites. Décocher « Reprendre » pour tout réécrire.' };
        }
        pending = pendingFrames(job.total, done).filter((f) => job.frames.includes(f));
      } else if (writer.resumable) {
        // Sans reprise, un dossier qui contient déjà les images d'un AUTRE export finirait mélangé si on annule
        // (les anciennes images porteraient la nouvelle empreinte) : on refuse.
        const done = await writer.existing();
        const meta = done.size > 0 ? await writer.readMeta() : null;
        const prev = meta ? (JSON.parse(meta) as { key?: string }).key : undefined;
        if (done.size > 0 && prev !== key) {
          return { ok: false, cancelled: false, message: `Ce dossier contient déjà ${done.size} image(s) d'un export aux réglages différents : choisir un dossier vide.` };
        }
      }
      await writer.writeMeta(JSON.stringify({ key, width: job.width, height: job.height, samples: job.samples, fps: job.fps, total: job.total, settings: this.host.settings() }, null, 2));
    } catch (e) {
      return { ok: false, cancelled: false, message: `Destination inutilisable : ${(e as Error).message}` };
    }
    if (pending.length === 0) return { ok: true, message: 'Toutes les images sont déjà écrites.', written: 0 };

    this.host.prepare();
    this.host.dof.beginStill(job.width, job.height);
    return new Promise<ExportEnd>((resolve) => {
      this.run = { job, writer, pending, i: 0, started: false, settle: -1, phase: 'render', written: 0, cancel: false, done: resolve };
    });
  }

  /** Un tour de boucle. Renvoie true tant que l'export tient le rendu (l'application ne doit pas rendre elle-même). */
  tick(): boolean {
    const r = this.run;
    if (!r) return false;
    if (r.phase === 'write') return true;                 // relecture / encodage / écriture en cours (asynchrone)
    if (r.cancel) { void r.writer.abort().then((message) => this.end({ ok: false, cancelled: true, message })); return true; }

    const frame = r.pending[r.i];
    const dof = this.host.dof;
    let finished: boolean;
    try {
      if (!r.started) {
        this.host.setFrame(frame, frameTime(frame, r.job.fps));
        r.started = true;
        r.settle = 0;
      }
      // Attente du tri des splats pour cette pose (au plus SETTLE_MAX images) : sans elle, les premiers
      // échantillons utiliseraient l'ordre de la pose précédente, différemment selon le timing.
      if (r.settle >= 0) {
        if (dof.settle() || ++r.settle >= SETTLE_MAX) { r.settle = -1; dof.reset(); }
        return true;
      }
      finished = dof.stillStep(STEP_SAMPLES, r.job.samples);
    } catch (e) {
      // GPU perdu, mémoire saturée… : on arrête proprement au lieu de relancer l'erreur à chaque image.
      r.phase = 'write';
      void r.writer.abort().then(() => this.end({ ok: false, cancelled: false, message: `Erreur de rendu à l'image ${frame + 1} : ${(e as Error).message}` }));
      return true;
    }
    this.onProgress({ done: r.i, count: r.pending.length, frame, sample: dof.accumulated, samples: r.job.samples });
    if (finished) {
      r.phase = 'write';
      void this.writeFrame(frame).then(() => {
        r.written++; r.i++; r.started = false;
        this.onProgress({ done: r.i, count: r.pending.length, frame, sample: r.job.samples, samples: r.job.samples });
        if (r.i >= r.pending.length) void this.finishOk();   // la phase reste « write » : plus de rendu
        else r.phase = 'render';
      }, (e: unknown) => { void r.writer.abort(); return this.end({ ok: false, cancelled: false, message: `Erreur à l'image ${frame + 1} : ${(e as Error).message}` }); });
    }
    return true;
  }

  private async writeFrame(frame: number): Promise<void> {
    const r = this.run!;
    const px = await this.host.dof.readStill();
    await r.writer.write(frame, px, r.job.width, r.job.height);
  }

  private async finishOk(): Promise<void> {
    const r = this.run!;
    try {
      const msg = await r.writer.finish();
      await this.end({ ok: true, message: `${r.written} image(s) exportée(s). ${msg}`, written: r.written });
    } catch (e) {
      await this.end({ ok: false, cancelled: false, message: `Fin d'export impossible : ${(e as Error).message}` });
    }
  }

  private async end(result: ExportEnd): Promise<void> {
    const r = this.run;
    if (!r) return;
    this.run = null;
    this.host.dof.endStill();
    this.host.restore();
    r.done(result);
  }
}
