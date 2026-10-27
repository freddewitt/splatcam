import { describe, expect, it } from 'vitest';
import { HOLD_MS, TimelineController, type TimelineEngine, type TrackValues } from './controller';
import { TRACK_IDS } from './shot';

class FakeEngine implements TimelineEngine {
  v = Object.fromEntries(TRACK_IDS.map((id) => [id, 0])) as TrackValues;
  read() { return { ...this.v }; }
  write(values: Partial<TrackValues>) { Object.assign(this.v, values); }
}

describe('TimelineController', () => {
  it('lecture : applique les pistes au temps courant', () => {
    const e = new FakeEngine(), c = new TimelineController(e);
    c.shot.tracks.x.keys = [];
    e.v.x = 0; c.keyNow(['x']);
    c.seek(5); e.v.x = 10; c.keyNow(['x']);
    c.seek(2.5); c.tick(0, 0);
    expect(e.v.x).toBeCloseTo(5, 6);
    c.seek(0); c.play(); c.tick(1, 0);
    expect(c.time).toBe(1);
    expect(e.v.x).toBeGreaterThan(0);
  });

  it('plan fini : arrêt ; boucle : repart', () => {
    const e = new FakeEngine(), c = new TimelineController(e);
    c.setDuration(2); c.play(); c.tick(3, 0);
    expect(c.playing).toBe(false);
    expect(c.time).toBe(2);
    c.setLoop(true); c.play(); c.tick(2.5, 0);
    expect(c.playing).toBe(true);
    expect(c.time).toBeCloseTo(0.5, 9);
  });

  it('enregistrement à l\'arrêt : un geste pose une clé au temps courant (caméra = 6 pistes)', () => {
    const e = new FakeEngine(), c = new TimelineController(e);
    c.seek(1.5); c.toggleRecord();
    e.v.x = 3; // geste à la main
    c.tick(0, 0);
    expect(c.shot.tracks.x.keys.map((k) => [k.t, k.v])).toEqual([[1.5, 3]]);
    expect(c.shot.tracks.pan.keys).toHaveLength(1);
    expect(c.shot.tracks.focus.keys).toHaveLength(0);
    e.v.x = 4; c.tick(0, 100); // même temps : la clé est mise à jour
    expect(c.shot.tracks.x.keys).toHaveLength(1);
    expect(c.shot.tracks.x.keys[0].v).toBe(4);
  });

  it('enregistrement en lecture : le geste prime puis la lecture reprend ; allègement à l\'arrêt', () => {
    const e = new FakeEngine(), c = new TimelineController(e);
    c.setDuration(10);
    c.toggleRecord(); c.play();
    let now = 0;
    for (let i = 0; i < 20; i++) { // 2 s de geste linéaire sur la map : 20 clés
      now += 100;
      e.v.focus = i * 0.1; // la main tire la bague
      c.tick(0.1, now);
    }
    expect(c.shot.tracks.focus.keys.length).toBeGreaterThan(15);
    expect(c.time).toBeCloseTo(2, 6);
    // la main lâche : pendant HOLD_MS la lecture n'écrase pas la valeur, ensuite elle la relit
    c.tick(0.1, now + 100);
    const held = e.v.focus;
    expect(held).toBeCloseTo(1.9, 6);
    c.tick(0.1, now + HOLD_MS + 50);
    c.pause();
    expect(c.shot.tracks.focus.keys.length).toBeLessThan(5); // geste linéaire → quelques clés
    // sans geste, les clés ne bougent pas les autres pistes
    expect(c.shot.tracks.zoom.keys).toHaveLength(0);
  });

  it('supprime la clé sélectionnée', () => {
    const e = new FakeEngine(), c = new TimelineController(e);
    c.keyNow(['zoom']);
    c.selection = { track: 'zoom', key: 0 };
    c.deleteSelected();
    expect(c.shot.tracks.zoom.keys).toHaveLength(0);
    expect(c.selection).toBeNull();
  });
});
