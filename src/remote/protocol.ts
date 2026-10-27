// Télécommande : messages échangés entre le téléphone et l'application sur le Mac (via le relais de
// tools/remote-plugin.ts). Le Mac fait le rendu ; le téléphone envoie des commandes et reçoit l'état.
// Module pur : toute commande reçue du réseau est validée ici avant d'agir sur l'application.

import { CAMERA_TRACKS, FOCUS_FAR_M, FOCUS_MIN_M, TRACK_IDS } from '../timeline/shot';
import type { TimelineController } from '../timeline/controller';
import { stepFNumber } from '../ui/shortcuts';

export type RemoteMode = 'explore' | 'shoot';

export type Command =
  | { cmd: 'play' | 'pause' | 'toggle' | 'home' | 'end' | 'rec' | 'loop' }
  | { cmd: 'seek'; t: number }
  | { cmd: 'step'; frames: number }
  | { cmd: 'key'; scope: 'all' | 'camera' }
  | { cmd: 'mode'; mode: RemoteMode }
  | { cmd: 'focal'; value: number }
  | { cmd: 'fnumber'; value: number }
  | { cmd: 'fstop'; thirds: number }
  | { cmd: 'focus'; meters: number };

/** État renvoyé au téléphone (valeurs en unités d'affichage : s, mm, f/N, m). */
export interface RemoteState {
  time: number;
  duration: number;
  playing: boolean;
  recording: boolean;
  loop: boolean;
  mode: RemoteMode;
  focal: number;
  fNumber: number;
  focusM: number;
  fps: number;
}

/** Ce dont les commandes ont besoin dans l'application (sans accès au moteur de rendu). */
export interface RemoteContext {
  timeline: TimelineController;
  setMode(mode: RemoteMode): void;
  fps(): number;
  focal(): number;
  setFocal(mm: number): void;
  fNumber(): number;
  setFNumber(f: number): void;
  focusM(): number;
  setFocusM(m: number): void;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export const FOCAL_RANGE = [4, 800] as const;
export const FNUMBER_RANGE = [0.7, 64] as const;
export const SIMPLE_COMMANDS = ['play', 'pause', 'toggle', 'home', 'end', 'rec', 'loop'] as const;

/** Commande valide (valeurs bornées) ou null : un message mal formé est ignoré, jamais appliqué à moitié. */
export function parseCommand(raw: unknown): Command | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const cmd = m.cmd;
  if ((SIMPLE_COMMANDS as readonly unknown[]).includes(cmd)) return { cmd: cmd as (typeof SIMPLE_COMMANDS)[number] };
  switch (cmd) {
    case 'seek': return finite(m.t) ? { cmd, t: Math.max(0, m.t) } : null;
    case 'step': return finite(m.frames) ? { cmd, frames: clamp(Math.round(m.frames), -1000, 1000) } : null;
    case 'key': return m.scope === 'all' || m.scope === 'camera' ? { cmd, scope: m.scope } : null;
    case 'mode': return m.mode === 'explore' || m.mode === 'shoot' ? { cmd, mode: m.mode } : null;
    case 'focal': return finite(m.value) ? { cmd, value: clamp(m.value, ...FOCAL_RANGE) } : null;
    case 'fnumber': return finite(m.value) ? { cmd, value: clamp(m.value, ...FNUMBER_RANGE) } : null;
    case 'fstop': return finite(m.thirds) ? { cmd, thirds: clamp(Math.round(m.thirds), -9, 9) } : null;
    case 'focus': return finite(m.meters) ? { cmd, meters: clamp(m.meters, FOCUS_MIN_M, FOCUS_FAR_M) } : null;
    default: return null;
  }
}

/** Applique une commande ; les gestes de la timeline passent en vue tournage (seule vue où elle agit). */
export function applyCommand(c: Command, ctx: RemoteContext): void {
  const tl = ctx.timeline;
  const shoot = () => ctx.setMode('shoot');
  switch (c.cmd) {
    case 'play': shoot(); tl.play(); break;
    case 'pause': tl.pause(); break;
    case 'toggle': if (tl.playing) tl.pause(); else { shoot(); tl.play(); } break;
    case 'home': shoot(); tl.seek(0); break;
    case 'end': shoot(); tl.seek(tl.shot.duration); break;
    case 'rec': shoot(); tl.toggleRecord(); break;
    case 'loop': tl.setLoop(!tl.shot.loop); break;
    case 'seek': shoot(); tl.seek(c.t); break;
    case 'step': shoot(); tl.seek(tl.time + c.frames / ctx.fps()); break;
    case 'key': shoot(); tl.keyNow(c.scope === 'all' ? TRACK_IDS : CAMERA_TRACKS); break;
    case 'mode': ctx.setMode(c.mode); break;
    case 'focal': ctx.setFocal(c.value); break;
    case 'fnumber': ctx.setFNumber(c.value); break;
    case 'fstop': ctx.setFNumber(stepFNumber(ctx.fNumber(), c.thirds)); break;
    case 'focus': ctx.setFocusM(c.meters); break;
  }
}

export function snapshotState(ctx: RemoteContext, mode: RemoteMode): RemoteState {
  const tl = ctx.timeline;
  return {
    time: Math.round(tl.time * 1000) / 1000, duration: tl.shot.duration,
    playing: tl.playing, recording: tl.recording, loop: tl.shot.loop, mode,
    focal: ctx.focal(), fNumber: ctx.fNumber(), focusM: Math.round(ctx.focusM() * 1000) / 1000, fps: ctx.fps(),
  };
}

/** Messages SSE du relais. */
export type RelayMessage =
  | { type: 'cmd'; cmd: unknown }       // vers le Mac
  | { type: 'peers'; n: number }        // vers le Mac : téléphones connectés
  | { type: 'state'; state: RemoteState } // vers les téléphones
  | { type: 'mac'; online: boolean };  // vers les téléphones

export interface RelayInfo {
  token: string;
  /** Adresses à ouvrir sur le téléphone (jeton inclus). */
  urls: string[];
  /** Le serveur écoute sur le réseau local (`--host`) ; sinon le téléphone ne peut pas l'atteindre. */
  exposed: boolean;
  https: boolean;
}
