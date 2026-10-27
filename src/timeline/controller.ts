// Contrôleur de timeline : temps de lecture, lecture / boucle, mode enregistrement, sélection.
// Aucun accès au moteur de rendu : tout passe par `TimelineEngine` (lire / écrire les valeurs courantes
// de la caméra, de la map et du zoom), ce qui rend la logique d'enregistrement testable.

import { setKey, removeKey, moveKey, thin, evaluate } from './track';
import { CAMERA_TRACKS, TRACK_IDS, advanceTime, newShot, sampleShot, type Shot, type TrackId } from './shot';

export type TrackValues = Record<TrackId, number>;

export interface TimelineEngine {
  /** Valeurs courantes (espaces de shot.ts : unités de scène, degrés, dioptries, ln(focale)). */
  read(): TrackValues;
  /** Applique les valeurs des pistes données ; les autres restent telles quelles. */
  write(values: Partial<TrackValues>): void;
}

/** Groupes qui se manipulent ensemble à la main : toucher la caméra pose une clé sur ses 6 pistes. */
const GROUPS: TrackId[][] = [[...CAMERA_TRACKS], ['focus'], ['zoom']];

/** Écart minimal (par piste) pour considérer qu'une valeur a été changée à la main. */
const MOVE_EPS: Record<TrackId, number> = { x: 1e-4, y: 1e-4, z: 1e-4, pan: 1e-3, tilt: 1e-3, roll: 1e-3, focus: 1e-4, zoom: 1e-4 };
/** Tolérance d'allègement des pistes enregistrées en lecture (Douglas-Peucker). */
const THIN_TOL: Record<TrackId, number> = { x: 2e-2, y: 2e-2, z: 2e-2, pan: 0.05, tilt: 0.05, roll: 0.05, focus: 3e-3, zoom: 3e-3 };
/** Après un geste à la main (enregistrement en lecture), la lecture reprend la piste après ce délai. */
export const HOLD_MS = 300;

export interface Selection { track: TrackId; key: number }

export class TimelineController {
  shot: Shot = newShot(5);
  time = 0;
  playing = false;
  recording = false;
  selection: Selection | null = null;
  /** Piste affichée dans l'éditeur de courbes. */
  curveTrack: TrackId = 'x';

  private last: TrackValues | null = null;
  private touchedAt = new Map<TrackId[], number>();
  private recordedWhilePlaying = new Set<TrackId>();
  private needApply = false;
  private listeners: (() => void)[] = [];

  constructor(private readonly engine: TimelineEngine) {}

  onChange(fn: () => void): void { this.listeners.push(fn); }
  emit(): void { for (const fn of this.listeners) fn(); }

  /** Remplace le plan (chargement de projet). */
  setShot(shot: Shot): void { this.shot = shot; this.selection = null; this.seek(Math.min(this.time, shot.duration)); }

  seek(t: number): void {
    this.time = Math.min(Math.max(t, 0), this.shot.duration);
    this.needApply = true;
    this.emit();
  }

  play(): void {
    if (this.time >= this.shot.duration) this.time = 0;
    this.playing = true;
    this.needApply = true;
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.finishRecording();
    this.emit();
  }

  toggleRecord(): void {
    this.recording = !this.recording;
    if (this.recording) this.last = this.engine.read(); else this.finishRecording();
    this.emit();
  }

  setDuration(d: number): void {
    this.shot.duration = Math.max(0.1, d);
    if (this.time > this.shot.duration) this.time = this.shot.duration;
    this.emit();
  }

  setLoop(loop: boolean): void { this.shot.loop = loop; this.emit(); }

  /** Pose une clé à la tête de lecture sur les pistes données, avec les valeurs courantes. */
  keyNow(ids: readonly TrackId[]): void {
    const cur = this.engine.read();
    for (const id of ids) setKey(this.shot.tracks[id], this.time, cur[id]);
    this.emit();
  }

  /** Pose une clé à `t` sur la piste `id` (valeur `v`, sinon celle de la courbe, sinon la valeur courante). Renvoie son index. */
  addKeyAt(id: TrackId, t: number, v?: number): number {
    const value = v ?? this.valueAt(id, t) ?? this.engine.read()[id];
    const i = setKey(this.shot.tracks[id], Math.min(Math.max(t, 0), this.shot.duration), value);
    this.selection = { track: id, key: i };
    this.curveTrack = id;
    this.needApply = true;
    this.emit();
    return i;
  }

  /** Déplace une clé (temps et valeur) et réapplique le plan. */
  moveKeyTo(id: TrackId, i: number, t: number, v: number): void {
    moveKey(this.shot.tracks[id], i, Math.min(Math.max(t, 0), this.shot.duration), v);
    this.needApply = true;
    this.emit();
  }

  /** Les poignées / modes changent la courbe : réappliquer et redessiner. */
  curveEdited(): void { this.needApply = true; this.emit(); }

  deleteSelected(): void {
    if (!this.selection) return;
    removeKey(this.shot.tracks[this.selection.track], this.selection.key);
    this.selection = null;
    this.needApply = true;
    this.emit();
  }

  /** Valeur de la piste à t (pour l'affichage), ou undefined si elle est vide. */
  valueAt(id: TrackId, t: number): number | undefined { return evaluate(this.shot.tracks[id], t); }

  /** Un tour de boucle : avance la lecture, enregistre les gestes à la main, applique le plan. */
  tick(dtSec: number, nowMs: number): void {
    if (this.playing) {
      const r = advanceTime(this.time, dtSec, this.shot);
      this.time = r.time;
      this.playing = r.playing;
      if (!r.playing) this.finishRecording();
      this.needApply = true;
    }
    const skip = new Set<TrackId>();
    if (this.recording) {
      const cur = this.engine.read();
      const last = this.last ?? cur;
      for (const group of GROUPS) {
        if (group.some((id) => Math.abs(cur[id] - last[id]) > MOVE_EPS[id])) {
          this.touchedAt.set(group, nowMs);
          for (const id of group) {
            setKey(this.shot.tracks[id], this.time, cur[id]);
            if (this.playing) this.recordedWhilePlaying.add(id);
          }
        }
        if (nowMs - (this.touchedAt.get(group) ?? -Infinity) < HOLD_MS) for (const id of group) skip.add(id);
      }
    }
    if (this.needApply) {
      const values = sampleShot(this.shot, this.time);
      for (const id of skip) delete values[id];
      this.engine.write(values);
      this.needApply = false;
    }
    if (this.recording) this.last = this.engine.read();
    if (this.playing || skip.size) this.emit();
  }

  private finishRecording(): void {
    for (const id of this.recordedWhilePlaying) thin(this.shot.tracks[id], THIN_TOL[id]);
    this.recordedWhilePlaying.clear();
    this.selection = null;
  }
}

export { TRACK_IDS };
