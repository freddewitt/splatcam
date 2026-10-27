// Projet SplatCam : fichier JSON qui garde réglages, pose des caméras et plan (timeline).
//
// La scène (données splat) n'est PAS dans le fichier : on garde son nom et on la redépose à l'ouverture.
// Les looks (.cube) et le masque de saleté sont aussi des références par nom, à recharger.
// Module pur (aucun accès au moteur ni au DOM) : tout ce qui est lu est validé champ par champ contre les
// valeurs par défaut, un fichier ancien, tronqué ou trafiqué ne peut donc pas casser l'état.

import { SENSOR_FORMATS } from '../optics/sensor';
import { FILM_STOCKS } from '../optics/film-stock';
import { LENS_PRESETS } from '../optics/lens-preset';
import { TRACK_IDS, newShot, type Shot } from '../timeline/shot';
import { refreshAuto, type Track } from '../timeline/track';
import type { Key, KeyMode } from '../timeline/curve';

export const PROJECT_FORMAT = 'splatcam-project';
export const PROJECT_VERSION = 1;

export interface OrbitData { yaw: number; pitch: number; roll: number; dist: number; target: [number, number, number] }

/** Réglages enregistrés (PanelState sans le mode de vue, qui n'est pas une propriété du projet). */
export interface ProjectSettings {
  sensorId: string; focal: number; metersPerUnit: number; fNumber: number; focusM: number; samples: number;
  aperture: Record<string, number>; shiftX: number; shiftY: number; tiltX: number; tiltY: number;
  fps: number; shutterAngle: number; readoutMs: number; weave: number;
  post: Record<string, unknown>; lutName: string; dirtName: string; presetId: string;
}

export interface Project {
  format: typeof PROJECT_FORMAT;
  version: number;
  /** ISO 8601, informatif. */
  savedAt: string;
  scene: { name: string };
  settings: ProjectSettings;
  orbits: { explore: OrbitData; shoot: OrbitData };
  shot: Shot;
}

export interface ParsedProject { project: Project; warnings: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Fusionne `input` dans une copie de `defaults` : une clé n'est reprise que si son type est celui de la valeur
 * par défaut (nombre fini, chaîne, booléen, tableau de même longueur, objet récursif). Le reste est ignoré.
 */
export function mergeDefaults<T>(defaults: T, input: unknown): T {
  if (Array.isArray(defaults)) {
    if (!Array.isArray(input) || input.length !== defaults.length) return structuredClone(defaults);
    return defaults.map((d, i) => mergeDefaults(d, input[i])) as T;
  }
  if (isObj(defaults)) {
    const src = isObj(input) ? input : {};
    const out: Record<string, unknown> = {};
    for (const [k, d] of Object.entries(defaults)) out[k] = mergeDefaults(d, src[k]);
    return out as T;
  }
  if (typeof defaults === 'number') return (typeof input === 'number' && Number.isFinite(input) ? input : defaults) as T;
  if (typeof defaults === 'string') return (typeof input === 'string' ? input : defaults) as T;
  if (typeof defaults === 'boolean') return (typeof input === 'boolean' ? input : defaults) as T;
  return defaults;
}

const KEY_MODES: readonly KeyMode[] = ['bezier', 'linear', 'hold'];
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function parseHandle(h: unknown) {
  const o = isObj(h) ? h : {};
  return { dt: num(o.dt, 0), dv: num(o.dv, 0) };
}

/** Clés d'une piste : triées par temps, les invalides sont écartées ; les poignées auto sont recalculées. */
function parseTrack(input: unknown): Track {
  const keys: Key[] = [];
  const list = isObj(input) && Array.isArray(input.keys) ? input.keys : [];
  for (const k of list) {
    if (!isObj(k) || typeof k.t !== 'number' || typeof k.v !== 'number' || !Number.isFinite(k.t) || !Number.isFinite(k.v)) continue;
    const hout = parseHandle(k.hout), hin = parseHandle(k.hin);
    keys.push({
      t: Math.max(0, k.t), v: k.v,
      hout: { dt: Math.max(0, hout.dt), dv: hout.dv }, hin: { dt: Math.min(0, hin.dt), dv: hin.dv },
      auto: typeof k.auto === 'boolean' ? k.auto : true,
      mode: KEY_MODES.includes(k.mode as KeyMode) ? (k.mode as KeyMode) : 'bezier',
    });
  }
  keys.sort((a, b) => a.t - b.t);
  const track: Track = { keys };
  refreshAuto(track);
  return track;
}

export function parseShot(input: unknown): Shot {
  const o = isObj(input) ? input : {};
  const shot = newShot(Math.max(0.1, num(o.duration, 5)));
  shot.loop = typeof o.loop === 'boolean' ? o.loop : false;
  const tracks = isObj(o.tracks) ? o.tracks : {};
  for (const id of TRACK_IDS) shot.tracks[id] = parseTrack(tracks[id]);
  return shot;
}

function parseOrbit(input: unknown, d: OrbitData): OrbitData {
  const m = mergeDefaults(d, input);
  m.pitch = Math.max(-89, Math.min(89, m.pitch));
  m.dist = Math.max(0.05, m.dist);
  return m;
}

/** Valeurs de repli (état de départ de l'application), fournies par l'appelant. */
export interface ProjectDefaults { settings: ProjectSettings; orbit: OrbitData }

export interface ProjectInput {
  sceneName: string;
  settings: ProjectSettings;
  orbits: { explore: OrbitData; shoot: OrbitData };
  shot: Shot;
}

export function serializeProject(input: ProjectInput, now = new Date()): string {
  const { seed: _seed, ...post } = input.settings.post;   // la graine suit l'image courante, pas le projet
  const project: Project = {
    format: PROJECT_FORMAT, version: PROJECT_VERSION, savedAt: now.toISOString(),
    scene: { name: input.sceneName },
    settings: { ...input.settings, post },
    orbits: input.orbits,
    shot: input.shot,
  };
  return JSON.stringify(project, null, 2);
}

/** Lit un projet. Lève une Error (message lisible) si ce n'est pas un projet SplatCam ou s'il vient du futur. */
export function parseProject(text: string, defaults: ProjectDefaults): ParsedProject {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('Fichier illisible (JSON invalide).'); }
  if (!isObj(raw) || raw.format !== PROJECT_FORMAT) throw new Error('Ce fichier n\'est pas un projet SplatCam.');
  if (typeof raw.version !== 'number' || raw.version < 1) throw new Error('Version de projet absente ou invalide.');
  if (raw.version > PROJECT_VERSION) throw new Error(`Projet enregistré par une version plus récente (v${raw.version}) : mise à jour de SplatCam nécessaire.`);

  const warnings: string[] = [];
  const settings = mergeDefaults(defaults.settings, isObj(raw.settings) ? raw.settings : {});

  // Identifiants à valeurs fermées : un inconnu retombe sur le défaut (et on le dit).
  const closed = (key: 'sensorId' | 'presetId', known: string[], allowEmpty: boolean) => {
    const v = settings[key];
    if (v === '' && allowEmpty) return;
    if (!known.includes(v)) { warnings.push(`${key === 'sensorId' ? 'Capteur' : 'Preset'} « ${v} » inconnu : valeur par défaut.`); settings[key] = defaults.settings[key]; }
  };
  closed('sensorId', SENSOR_FORMATS.map((s) => s.id), false);
  closed('presetId', LENS_PRESETS.map((p) => p.id), true);
  const tone = settings.post.toneMap;
  if (tone !== 'none' && tone !== 'reinhard' && tone !== 'aces') { warnings.push(`Tone mapping « ${String(tone)} » inconnu.`); settings.post.toneMap = defaults.settings.post.toneMap; }
  const stock = settings.post.stock;
  if (typeof stock === 'string' && stock !== '' && !FILM_STOCKS.some((s) => s.id === stock)) { warnings.push(`Émulsion « ${stock} » inconnue : aucune.`); settings.post.stock = ''; }

  // Bornes minimales : un fichier édité à la main ne doit pas produire de division par zéro.
  settings.focal = Math.min(Math.max(settings.focal, 4), 800);
  settings.fNumber = Math.max(settings.fNumber, 0.5);
  settings.metersPerUnit = settings.metersPerUnit > 0 ? settings.metersPerUnit : defaults.settings.metersPerUnit;
  settings.focusM = Math.max(settings.focusM, 0.01);
  settings.samples = Math.max(1, Math.round(settings.samples));
  settings.fps = settings.fps > 0 ? settings.fps : defaults.settings.fps;
  settings.shutterAngle = Math.min(Math.max(settings.shutterAngle, 0), 360);

  const orbits = isObj(raw.orbits) ? raw.orbits : {};
  const scene = isObj(raw.scene) ? raw.scene : {};
  const project: Project = {
    format: PROJECT_FORMAT, version: PROJECT_VERSION,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : '',
    scene: { name: typeof scene.name === 'string' ? scene.name : '' },
    settings,
    orbits: { explore: parseOrbit(orbits.explore, defaults.orbit), shoot: parseOrbit(orbits.shoot, defaults.orbit) },
    shot: parseShot(raw.shot),
  };
  if (settings.lutName) warnings.push(`Look « ${settings.lutName} » à recharger (référence par nom).`);
  if (settings.dirtName) warnings.push(`Masque de saleté « ${settings.dirtName} » à recharger (référence par nom).`);
  return { project, warnings };
}

/** Nom de fichier proposé : nom de la scène sans extension, sinon « plan ». */
export function projectFileName(sceneName: string): string {
  const base = sceneName.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
  return `${base || 'plan'}.splatcam.json`;
}
