import { describe, expect, it } from 'vitest';
import { applyCommand, parseCommand, snapshotState, type RemoteContext } from './protocol';
import { TimelineController, type TimelineEngine, type TrackValues } from '../timeline/controller';
import { TRACK_IDS } from '../timeline/shot';
import { isLoopback, tokenMatches } from '../../tools/remote-plugin';

class FakeEngine implements TimelineEngine {
  v = Object.fromEntries(TRACK_IDS.map((id) => [id, 0])) as TrackValues;
  read() { return { ...this.v }; }
  write(values: Partial<TrackValues>) { Object.assign(this.v, values); }
}

function fake() {
  const timeline = new TimelineController(new FakeEngine());
  const s = { mode: 'explore' as 'explore' | 'shoot', focal: 35, fNumber: 2.8, focusM: 5, fps: 25 };
  const ctx: RemoteContext = {
    timeline,
    setMode: (m) => { s.mode = m; },
    fps: () => s.fps,
    focal: () => s.focal, setFocal: (v) => { s.focal = v; },
    fNumber: () => s.fNumber, setFNumber: (v) => { s.fNumber = v; },
    focusM: () => s.focusM, setFocusM: (v) => { s.focusM = v; },
  };
  return { ctx, s, timeline };
}

describe('télécommande : validation des commandes', () => {
  it('commandes simples et bornées', () => {
    expect(parseCommand({ cmd: 'toggle' })).toEqual({ cmd: 'toggle' });
    expect(parseCommand({ cmd: 'focal', value: 1e9 })).toEqual({ cmd: 'focal', value: 800 });
    expect(parseCommand({ cmd: 'focal', value: -5 })).toEqual({ cmd: 'focal', value: 4 });
    expect(parseCommand({ cmd: 'fnumber', value: 0 })).toEqual({ cmd: 'fnumber', value: 0.7 });
    expect(parseCommand({ cmd: 'focus', meters: 0 })).toEqual({ cmd: 'focus', meters: 0.25 });
    expect(parseCommand({ cmd: 'focus', meters: 1e6 })).toEqual({ cmd: 'focus', meters: 1000 });
    expect(parseCommand({ cmd: 'seek', t: -3 })).toEqual({ cmd: 'seek', t: 0 });
    expect(parseCommand({ cmd: 'step', frames: 2.6 })).toEqual({ cmd: 'step', frames: 3 });
    expect(parseCommand({ cmd: 'fstop', thirds: 99 })).toEqual({ cmd: 'fstop', thirds: 9 });
  });

  it('refuse le mal formé, sans exception', () => {
    for (const bad of [null, undefined, 3, 'play', [], {}, { cmd: 'format' }, { cmd: 'seek' }, { cmd: 'seek', t: 'x' }, { cmd: 'focal', value: NaN },
      { cmd: 'focal', value: Infinity }, { cmd: 'mode', mode: 'vr' }, { cmd: 'key', scope: 'tout' }, { cmd: '__proto__' }, { cmd: 'constructor' }]) {
      expect(parseCommand(bad)).toBeNull();
    }
  });

  it('ne garde que les champs connus', () => {
    expect(parseCommand({ cmd: 'seek', t: 1, extra: 'x', __proto__: { y: 1 } })).toEqual({ cmd: 'seek', t: 1 });
  });
});

describe('télécommande : application des commandes', () => {
  it('lecture depuis l\'exploration : passe en tournage et joue', () => {
    const { ctx, s, timeline } = fake();
    applyCommand({ cmd: 'toggle' }, ctx);
    expect(s.mode).toBe('shoot');
    expect(timeline.playing).toBe(true);
    applyCommand({ cmd: 'toggle' }, ctx);
    expect(timeline.playing).toBe(false);
  });

  it('image par image au rythme de la cadence, bornée au plan', () => {
    const { ctx, timeline } = fake();
    applyCommand({ cmd: 'step', frames: 1 }, ctx);
    expect(timeline.time).toBeCloseTo(0.04, 9);
    applyCommand({ cmd: 'step', frames: -10 }, ctx);
    expect(timeline.time).toBe(0);
    applyCommand({ cmd: 'seek', t: 99 }, ctx);
    expect(timeline.time).toBe(timeline.shot.duration);
    applyCommand({ cmd: 'home' }, ctx);
    expect(timeline.time).toBe(0);
  });

  it('clés : tout (8 pistes) ou caméra seule (6)', () => {
    const { ctx, timeline } = fake();
    applyCommand({ cmd: 'key', scope: 'camera' }, ctx);
    expect(TRACK_IDS.filter((id) => timeline.shot.tracks[id].keys.length).length).toBe(6);
    applyCommand({ cmd: 'key', scope: 'all' }, ctx);
    expect(TRACK_IDS.filter((id) => timeline.shot.tracks[id].keys.length).length).toBe(8);
  });

  it('objectif : focale, diaph au tiers, mise au point', () => {
    const { ctx, s } = fake();
    applyCommand({ cmd: 'focal', value: 85 }, ctx);
    applyCommand({ cmd: 'fstop', thirds: -1 }, ctx);
    applyCommand({ cmd: 'focus', meters: 2.5 }, ctx);
    expect([s.focal, s.fNumber, s.focusM]).toEqual([85, 2.5, 2.5]);
    applyCommand({ cmd: 'fnumber', value: 1.4 }, ctx);
    expect(s.fNumber).toBe(1.4);
  });

  it('enregistrement, boucle, mode', () => {
    const { ctx, s, timeline } = fake();
    applyCommand({ cmd: 'loop' }, ctx);
    expect(timeline.shot.loop).toBe(true);
    applyCommand({ cmd: 'rec' }, ctx);
    expect(timeline.recording).toBe(true);
    expect(s.mode).toBe('shoot');
    applyCommand({ cmd: 'mode', mode: 'explore' }, ctx);
    expect(s.mode).toBe('explore');
  });

  it('état envoyé au téléphone', () => {
    const { ctx, timeline } = fake();
    timeline.seek(1.23456);
    expect(snapshotState(ctx, 'shoot')).toEqual({ time: 1.235, duration: 5, playing: false, recording: false, loop: false, mode: 'shoot', focal: 35, fNumber: 2.8, focusM: 5, fps: 25 });
  });
});

describe('relais : jeton et provenance', () => {
  it('jeton comparé strictement', () => {
    expect(tokenMatches('abc123', 'abc123')).toBe(true);
    expect(tokenMatches('abc124', 'abc123')).toBe(false);
    expect(tokenMatches('abc12', 'abc123')).toBe(false);
    expect(tokenMatches('', 'abc123')).toBe(false);
    expect(tokenMatches(null, 'abc123')).toBe(false);
  });
  it('boucle locale reconnue, adresses du réseau refusées', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('192.168.1.20')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});
