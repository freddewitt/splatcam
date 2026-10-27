import { describe, expect, it } from 'vitest';
import { mergeDefaults, parseProject, projectFileName, serializeProject, type OrbitData, type ProjectDefaults, type ProjectSettings } from './project';
import { newShot } from '../timeline/shot';
import { setKey } from '../timeline/track';
import { evaluate } from '../timeline/track';

const settings = (): ProjectSettings => ({
  sensorId: 's35-16x9', focal: 35, metersPerUnit: 1, fNumber: 2.8, focusM: 5, samples: 64,
  aperture: { blades: 0, roundness: 1, squeeze: 1 }, shiftX: 0, shiftY: 0, tiltX: 0, tiltY: 0,
  fps: 25, shutterAngle: 180, readoutMs: 0, weave: 0,
  post: { toneMap: 'aces', bloom: 0, halationTint: [1, 0.3, 0.1], stock: '', seed: 0 },
  lutName: '', dirtName: '', presetId: '',
});
const orbit = (): OrbitData => ({ yaw: 0, pitch: -15, roll: 0, dist: 4, target: [0, 0, 0] });
const defaults: ProjectDefaults = { settings: settings(), orbit: orbit() };

function sample() {
  const shot = newShot(8);
  setKey(shot.tracks.x, 0, 0);
  setKey(shot.tracks.x, 2, 3);
  setKey(shot.tracks.x, 4, 1);
  setKey(shot.tracks.focus, 1, 0.5);
  shot.loop = true;
  const s = settings();
  s.focal = 50; s.fNumber = 1.4; s.post = { ...s.post, bloom: 0.4, seed: 123 };
  return { sceneName: 'salon.ply', settings: s, orbits: { explore: orbit(), shoot: { ...orbit(), yaw: 180, target: [1, 2, 3] as [number, number, number] } }, shot };
}

describe('projet JSON', () => {
  it('aller-retour : réglages, orbites et plan identiques', () => {
    const input = sample();
    const { project, warnings } = parseProject(serializeProject(input), defaults);
    expect(warnings).toEqual([]);
    expect(project.scene.name).toBe('salon.ply');
    expect(project.settings.focal).toBe(50);
    expect(project.settings.fNumber).toBe(1.4);
    expect(project.settings.post.bloom).toBe(0.4);
    expect(project.orbits.shoot.target).toEqual([1, 2, 3]);
    expect(project.shot.duration).toBe(8);
    expect(project.shot.loop).toBe(true);
    expect(project.shot.tracks.x.keys).toEqual(input.shot.tracks.x.keys);
    for (const t of [0, 0.7, 1.5, 2, 3.1, 6]) expect(evaluate(project.shot.tracks.x, t)).toBeCloseTo(evaluate(input.shot.tracks.x, t)!, 9);
  });

  it('la graine de bruit n\'est pas enregistrée (elle suit l\'image courante)', () => {
    const text = serializeProject(sample());
    expect(JSON.parse(text).settings.post.seed).toBeUndefined();
    expect(parseProject(text, defaults).project.settings.post.seed).toBe(0);
  });

  it('champs manquants ou de mauvais type : valeurs par défaut', () => {
    const text = JSON.stringify({ format: 'splatcam-project', version: 1, settings: { focal: 'long', fNumber: null, fps: 24, post: { bloom: 'x' } } });
    const { project } = parseProject(text, defaults);
    expect(project.settings.focal).toBe(35);
    expect(project.settings.fNumber).toBe(2.8);
    expect(project.settings.fps).toBe(24);
    expect(project.settings.post.bloom).toBe(0);
    expect(project.orbits.shoot).toEqual(orbit());
    expect(project.shot.duration).toBe(5);
  });

  it('refuse un fichier étranger, illisible ou venu du futur', () => {
    expect(() => parseProject('pas du json', defaults)).toThrow(/illisible/);
    expect(() => parseProject('{"format":"autre","version":1}', defaults)).toThrow(/pas un projet/);
    expect(() => parseProject('[]', defaults)).toThrow(/pas un projet/);
    expect(() => parseProject('{"format":"splatcam-project","version":99}', defaults)).toThrow(/plus récente/);
    expect(() => parseProject('{"format":"splatcam-project"}', defaults)).toThrow(/Version/);
  });

  it('identifiants inconnus : repli et avertissement', () => {
    const text = JSON.stringify({ format: 'splatcam-project', version: 1, settings: { sensorId: 'imax-70', presetId: 'nope', post: { toneMap: 'filmic', stock: 'fantome' } } });
    const { project, warnings } = parseProject(text, defaults);
    expect(project.settings.sensorId).toBe('s35-16x9');
    expect(project.settings.presetId).toBe('');
    expect(project.settings.post.toneMap).toBe('aces');
    expect(project.settings.post.stock).toBe('');
    expect(warnings).toHaveLength(4);
  });

  it('valeurs aberrantes bornées (focale, ouverture, échelle, obturateur, pitch)', () => {
    const text = JSON.stringify({
      format: 'splatcam-project', version: 1,
      settings: { focal: 1e6, fNumber: 0, metersPerUnit: -3, focusM: 0, samples: 0.2, fps: 0, shutterAngle: 900 },
      orbits: { shoot: { pitch: 400, dist: 0 } },
    });
    const { project } = parseProject(text, defaults);
    const s = project.settings;
    expect(s.focal).toBe(800);
    expect(s.fNumber).toBe(0.5);
    expect(s.metersPerUnit).toBe(1);
    expect(s.focusM).toBe(0.01);
    expect(s.samples).toBe(1);
    expect(s.fps).toBe(25);
    expect(s.shutterAngle).toBe(360);
    expect(project.orbits.shoot.pitch).toBe(89);
    expect(project.orbits.shoot.dist).toBe(0.05);
  });

  it('plan : clés invalides écartées, triées, poignées auto recalculées', () => {
    const text = JSON.stringify({
      format: 'splatcam-project', version: 1,
      shot: { duration: -2, tracks: { x: { keys: [
        { t: 3, v: 1 }, { t: 'a', v: 1 }, { t: 1, v: 0, mode: 'zigzag' }, null, { t: 2, v: Infinity }, { t: 2, v: 5, auto: true },
      ] } } },
    });
    const { shot } = parseProject(text, defaults).project;
    expect(shot.duration).toBe(0.1);
    expect(shot.tracks.x.keys.map((k) => k.t)).toEqual([1, 2, 3]);
    expect(shot.tracks.x.keys[0].mode).toBe('bezier');
    expect(shot.tracks.x.keys[1].hout.dt).toBeGreaterThan(0);
    expect(shot.tracks.zoom.keys).toEqual([]);
  });

  it('mergeDefaults : tableaux de longueur différente rejetés, copie profonde', () => {
    const d = { tint: [1, 0.3, 0.1], n: 1 };
    const out = mergeDefaults(d, { tint: [1, 2], n: 4 });
    expect(out.tint).toEqual([1, 0.3, 0.1]);
    expect(out.n).toBe(4);
    out.tint[0] = 9;
    expect(d.tint[0]).toBe(1);
  });

  it('nom de fichier proposé', () => {
    expect(projectFileName('salon.ply')).toBe('salon.splatcam.json');
    expect(projectFileName('Mon salon (v2).sog')).toBe('Mon_salon_v2_.splatcam.json');
    expect(projectFileName('')).toBe('plan.splatcam.json');
  });
});
