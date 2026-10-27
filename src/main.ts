import * as pc from 'playcanvas';
import { DEFAULT_SENSOR_ID, getSensor, rad2deg, sensorFov } from './optics/sensor';
import { createPanel, type PanelState } from './ui/panel';
import { DEFAULT_POST, DIRT_SIZE } from './render/post';
import { DofRenderer } from './render/dof-renderer';
import { pickDepth, type PickData } from './render/pick';
import { DEFAULT_APERTURE } from './optics/aperture';
import { focusThroughPoint, tiltGradient } from './optics/tilt';
import { TimelineController, type TimelineEngine, type TrackValues } from './timeline/controller';
import { CAMERA_TRACKS, dioptersFromMeters, focalFromZoom, metersFromDiopters, sampleShot, zoomFromFocal } from './timeline/shot';
import { exposurePlan, gateWeave } from './optics/camera-defects';
import { createTimelineUI } from './ui/timeline-ui';
import { Exporter, type ExportHost } from './export/exporter';
import { folderSink } from './export/sinks';
import { pngWriter } from './export/writers';
import { createExportUi } from './ui/export-ui';
import { getStock } from './optics/film-stock';
import { parseProject, projectFileName, serializeProject, type OrbitData, type Project, type ProjectSettings } from './project/project';
import { createProjectUi } from './ui/project-ui';
import { createShortcuts } from './ui/shortcuts';
import { startRemoteHost } from './remote/host';
import { createRemoteUi } from './ui/remote-ui';

const canvas = document.getElementById('app') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const hint = document.getElementById('hint')!;

const device = await pc.createGraphicsDevice(canvas, { deviceTypes: ['webgpu'], antialias: false });

const createOptions = new pc.AppOptions();
createOptions.graphicsDevice = device;
createOptions.componentSystems = [pc.CameraComponentSystem, pc.GSplatComponentSystem];
createOptions.resourceHandlers = [pc.GSplatHandler, pc.TextureHandler, pc.ContainerHandler];

const app = new pc.AppBase(canvas);
app.init(createOptions);
// Le canvas occupe l'espace libre entre la barre, le panneau et la timeline (positionné en CSS, index.html) :
// le cadre de tournage n'est plus masqué par les panneaux. Redimensionnement regroupé à une fois par image.
app.setCanvasFillMode(pc.FILLMODE_NONE);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
let resizeQueued = false;
new ResizeObserver(() => {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => { resizeQueued = false; app.updateCanvasSize(); applyCameras(); });
}).observe(canvas);
// Hauteur de la timeline → variable CSS (la vue 3D s'arrête au-dessus).
const timelineEl = document.getElementById('timeline')!;
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--tl-h', `${timelineEl.offsetHeight}px`);
}).observe(timelineEl);

// État réglable depuis le panneau.
const state: PanelState = { mode: 'explore', sensorId: DEFAULT_SENSOR_ID, focal: 35, metersPerUnit: 1, fNumber: 2.8, focusM: 5, samples: 64,
  aperture: { ...DEFAULT_APERTURE }, shiftX: 0, shiftY: 0, tiltX: 0, tiltY: 0, fps: 25, shutterAngle: 180, readoutMs: 0, weave: 0, post: { ...DEFAULT_POST }, lutName: '', dirtName: '', presetId: '' };

// Écran étroit : le panneau de réglages s'ouvre et se ferme avec ce bouton (CSS, index.html).
const panelToggle = document.getElementById('panel-toggle')!;
panelToggle.addEventListener('click', () => {
  const open = document.body.classList.toggle('panel-open');
  panelToggle.textContent = open ? 'Fermer' : 'Réglages';
});

// Rendu manuel : en exploration une image normale par tick, en tournage N sous-rendus accumulés.
app.autoRender = false;
let dirty = true;
/** Exploration : nombre d'images encore à rendre. Le tri des splats arrive une ou deux images après un mouvement,
 *  on rend donc quelques images de plus puis on s'arrête : GPU au repos quand rien ne bouge (chaleur, batterie). */
const EXPLORE_SETTLE_FRAMES = 12;
let renderBurst = EXPLORE_SETTLE_FRAMES;

// Caméra de fond : efface tout l'écran (les bandes noires du cadre de tournage).
const bg = new pc.Entity('background');
bg.addComponent('camera', { clearColor: new pc.Color(0, 0, 0), layers: [], priority: 0 });
app.root.addChild(bg);

// Deux caméras indépendantes : exploration (libre, debug) et tournage (capteur + focale réels).
const explore = new pc.Entity('explore');
explore.addComponent('camera', { clearColor: new pc.Color(0.07, 0.07, 0.07), fov: 50, nearClip: 0.05, farClip: 1000, priority: 1 });
app.root.addChild(explore);
const shoot = new pc.Entity('shoot');
// Le tournage rend en HDR linéaire dans une cible RGBA16F : pas de gamma ni de tone mapping caméra.
// Fond ≈ 0,07 une fois encodé sRGB (0,006 linéaire).
shoot.addComponent('camera', {
  clearColor: new pc.Color(0.006, 0.006, 0.006), nearClip: 0.05, farClip: 1000, priority: 1,
  gammaCorrection: pc.GAMMA_NONE, toneMapping: pc.TONEMAP_LINEAR,
});
app.root.addChild(shoot);

// Orbite de debug : angles + distance autour d'une cible (unités de scène), un état par caméra.
interface Orbit { yaw: number; pitch: number; roll: number; dist: number; target: pc.Vec3 }
const newOrbit = (): Orbit => ({ yaw: 0, pitch: -15, roll: 0, dist: 4, target: new pc.Vec3(0, 0, 0) });
const orbits = { explore: newOrbit(), shoot: newOrbit() };
const cams = { explore, shoot };

function poseCamera(mode: 'explore' | 'shoot') {
  const o = orbits[mode], cam = cams[mode];
  cam.setPosition(o.target);
  cam.setEulerAngles(o.pitch, o.yaw, o.roll);
  cam.translateLocal(0, 0, o.dist);
}

/** Applique mode, capteur, focale et cadre de tournage (letterbox au format du capteur). */
function applyCameras() {
  const sensor = getSensor(state.sensorId);
  const fov = sensorFov(sensor, state.focal);
  const shooting = state.mode === 'shoot';
  explore.camera!.enabled = !shooting;
  shoot.camera!.enabled = shooting;

  // PlayCanvas : `fov` est vertical par défaut (horizontalFov = false).
  const sc = shoot.camera!;
  sc.horizontalFov = false;
  sc.fov = rad2deg(fov.v);
  sc.aspectRatioMode = pc.ASPECT_MANUAL;
  sc.aspectRatio = sensor.width / sensor.height;
  // Le cadre au rapport du capteur est produit par le rendu HDR (cible à ce rapport) puis affiché
  // en lettre-boîte par DofRenderer ; la caméra elle-même remplit sa cible.
  if (shooting) {
    dof.setLens({
      fovV: rad2deg(fov.v), aspect: sensor.width / sensor.height, focalMm: state.focal,
      fNumber: state.fNumber, focusM: state.focusM, metersPerUnit: state.metersPerUnit,
      aperture: state.aperture,
      // Shift : 2 · mm / taille du capteur = décalage du cadre en NDC (P02 / P12 = +2s/W : le cadre monte avec le shift).
      shiftNdc: { x: (2 * state.shiftX) / sensor.width, y: (2 * state.shiftY) / sensor.height },
      tiltDeg: { x: state.tiltX, y: state.tiltY },
    });
    updateMotion();
  } else {
    dof.detach();
  }
  dof.targetSamples = state.samples;
  dirty = true;
  renderBurst = EXPLORE_SETTLE_FRAMES;

  poseCamera('explore');
  poseCamera('shoot');
  panel.show(fov, orbits[state.mode].dist * state.metersPerUnit);
}

const dof = new DofRenderer(app, shoot);
const panel = createPanel(state, applyCameras, {
  post: () => dof.setPost(state.post),
  lut: (lut) => dof.postProcessor.setLut(lut),
  stock: (s) => dof.postProcessor.setStock(s),
  dirt: (bytes, size) => dof.postProcessor.setDirt(bytes, size),
});
dof.postParams = state.post;
applyCameras();

// Timeline : pistes caméra (pose réelle de la caméra de tournage), map (dioptries) et zoom (ln focale).
// La pose est lue / écrite dans l'orbite de tournage, qui reste la source de vérité (pan = yaw, tilt = pitch).
const timelineEngine: TimelineEngine = {
  read(): TrackValues {
    const o = orbits.shoot, p = shoot.getPosition();
    return {
      x: p.x, y: p.y, z: p.z, pan: o.yaw, tilt: o.pitch, roll: o.roll,
      focus: dioptersFromMeters(state.focusM), zoom: zoomFromFocal(state.focal),
    };
  },
  write(v) {
    const o = orbits.shoot, cur = timelineEngine.read();
    const pose = { ...cur, ...v };
    if (['x', 'y', 'z', 'pan', 'tilt', 'roll'].some((id) => id in v)) {
      o.yaw = pose.pan; o.pitch = pose.tilt; o.roll = pose.roll;
      // La caméra regarde −Z local : la cible d'orbite est devant elle, à `dist`.
      const fwd = new pc.Quat().setFromEulerAngles(o.pitch, o.yaw, o.roll).transformVector(pc.Vec3.FORWARD);
      o.target.set(pose.x, pose.y, pose.z).add(fwd.mulScalar(o.dist));
    }
    if ('focus' in v) state.focusM = metersFromDiopters(pose.focus);
    if ('zoom' in v) state.focal = Math.round(focalFromZoom(pose.zoom) * 100) / 100;
    applyCameras();
    panel.sync();
  },
};
const timeline = new TimelineController(timelineEngine);

// Flou de mouvement, rolling shutter, gate weave : chaque sous-rendu place la caméra à son instant dans
// la fenêtre d'exposition. Le mouvement est lu comme un DELTA du plan par rapport à l'instant de l'image
// (la caméra peut avoir été déplacée à la main : pas de saut), le gate weave s'y ajoute.
let origin: { pos: pc.Vec3; pan: number; tilt: number; roll: number; focus: number; zoom: number; at: Partial<TrackValues> } | null = null;
function updateMotion() {
  const plan = exposurePlan(state.shutterAngle, state.fps, state.readoutMs);
  if (!plan.active && state.weave <= 0) { dof.motion = null; return; }
  dof.motion = {
    plan,
    apply(u) {
      const o = orbits.shoot, sensor = getSensor(state.sensorId);
      origin ??= {
        pos: shoot.getPosition().clone(), pan: o.yaw, tilt: o.pitch, roll: o.roll,
        focus: dioptersFromMeters(state.focusM), zoom: zoomFromFocal(state.focal), at: sampleShot(timeline.shot, timeline.time),
      };
      const now = sampleShot(timeline.shot, timeline.time + u);
      const d = (id: keyof TrackValues) => (now[id] !== undefined && origin!.at[id] !== undefined ? now[id]! - origin!.at[id]! : 0);
      const wv = gateWeave(timeline.time + u, state.weave);
      shoot.setPosition(origin.pos.x + d('x'), origin.pos.y + d('y'), origin.pos.z + d('z'));
      shoot.setEulerAngles(origin.tilt + d('tilt'), origin.pan + d('pan'), origin.roll + d('roll') + wv.rollDeg);
      const focalMm = focalFromZoom(origin.zoom + d('zoom'));
      const fovV = rad2deg(sensorFov(sensor, focalMm).v);
      shoot.camera!.fov = fovV;
      return { fovV, focalMm, focusM: metersFromDiopters(origin.focus + d('focus')), extraShiftNdc: { x: wv.x, y: wv.y } };
    },
    restore() {
      origin = null;
      poseCamera('shoot');
      shoot.camera!.fov = rad2deg(sensorFov(getSensor(state.sensorId), state.focal).v);
    },
  };
}
updateMotion();
createTimelineUI(timelineEl, timeline, { fps: () => state.fps, locked: () => exporter.running });
// Lancer la lecture depuis l'exploration bascule en tournage (seule vue où la timeline pilote la caméra).
timeline.onChange(() => {
  if (timeline.playing && state.mode === 'explore') { state.mode = 'shoot'; panel.sync(); applyCameras(); }
});

// Export de séquence : rend le plan image par image à la résolution voulue (voir src/export/).
let exportSnap: { mode: typeof state.mode; time: number; recording: boolean; focusM: number; focal: number; seed: number; orbit: Orbit } | null = null;
const exportHost: ExportHost = {
  dof,
  prepare() {
    const o = orbits.shoot;
    exportSnap = { mode: state.mode, time: timeline.time, recording: timeline.recording, focusM: state.focusM, focal: state.focal, seed: state.post.seed, orbit: { ...o, target: o.target.clone() } };
    timeline.pause();
    timeline.recording = false;
    state.mode = 'shoot';
    panel.sync();
    applyCameras();
  },
  setFrame(index, t) {
    timeline.seek(t);
    timeline.tick(0, performance.now());   // applique le plan à t (pose, map, zoom) avant le premier sous-rendu
    state.post.seed = index;               // même image = même bruit que l'aperçu
  },
  restore() {
    const snap = exportSnap;
    exportSnap = null;
    if (!snap) return;
    // On rend la main sans rejouer le plan : la caméra revient où l'utilisateur l'avait posée.
    Object.assign(orbits.shoot, { ...snap.orbit, target: orbits.shoot.target.copy(snap.orbit.target) });
    state.mode = snap.mode; state.focusM = snap.focusM; state.focal = snap.focal; state.post.seed = snap.seed;
    timeline.time = snap.time; timeline.recording = snap.recording;
    timeline.emit();
    panel.sync();
    applyCameras();
  },
  settings() {
    // Les valeurs que le plan écrase (pose, map, zoom) ne comptent que si leur piste est vide.
    const tr = timeline.shot.tracks, o = orbits.shoot;
    const { mode: _mode, focusM, focal, post, ...rest } = state;
    return {
      ...rest, post: { ...post, seed: 0 }, scene: sceneName,
      focusM: tr.focus.keys.length ? null : focusM,
      focal: tr.zoom.keys.length ? null : focal,
      pose: CAMERA_TRACKS.some((id) => tr[id].keys.length) ? null : { yaw: o.yaw, pitch: o.pitch, roll: o.roll, dist: o.dist, target: [o.target.x, o.target.y, o.target.z] },
      shot: timeline.shot,
    };
  },
};
let exportUi: ReturnType<typeof createExportUi>;
const exporter = new Exporter(exportHost, (p) => exportUi.setProgress(p));
exportUi = createExportUi(document.getElementById('export')!, {
  exporter: () => exporter,
  info: () => {
    const sensor = getSensor(state.sensorId);
    return { aspect: sensor.width / sensor.height, fps: state.fps, duration: timeline.shot.duration, currentFrame: Math.round(timeline.time * state.fps), samples: state.samples, maxDim: device.maxTextureSize };
  },
});

let drag: { x: number; y: number; pan: boolean; moved: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  if (exporter.running) return;
  drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey, moved: 0 };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', (e) => {
  // Clic sans glissement en mode tournage : mise au point sur la surface cliquée.
  if (drag && !drag.pan && drag.moved < 4 && state.mode === 'shoot') focusAt(e.clientX, e.clientY);
  drag = null;
});
canvas.addEventListener('pointercancel', () => { drag = null; });
canvas.addEventListener('lostpointercapture', () => { drag = null; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointermove', (e) => {
  if (!drag || exporter.running) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  const o = orbits[state.mode], cam = cams[state.mode];
  if (drag.pan) {
    const k = o.dist * 0.0015;
    o.target.add(cam.right.clone().mulScalar(-dx * k)).add(cam.up.clone().mulScalar(dy * k));
  } else {
    o.yaw -= dx * 0.3;
    o.pitch = Math.max(-89, Math.min(89, o.pitch - dy * 0.3));
  }
  applyCameras();
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (exporter.running) return;
  const o = orbits[state.mode];
  o.dist = Math.max(0.05, o.dist * Math.exp(e.deltaY * 0.001));
  applyCameras();
}, { passive: false });

// Projet JSON : réglages, orbites et plan (la scène est une référence par nom, voir src/project/).
const settingsOf = (): ProjectSettings => {
  const { mode: _mode, ...rest } = state;
  return structuredClone(rest) as unknown as ProjectSettings;
};
const DEFAULT_SETTINGS = settingsOf();
const orbitData = (o: Orbit): OrbitData => ({ yaw: o.yaw, pitch: o.pitch, roll: o.roll, dist: o.dist, target: [o.target.x, o.target.y, o.target.z] });
const DEFAULT_ORBIT = orbitData(newOrbit());
let sceneName = '';
/** Nom de la scène du projet ouvert tant qu'elle n'est pas redéposée : la pose du projet prime sur le cadrage automatique. */
let awaitingScene: string | null = null;

function applyProject(p: Project) {
  const { post, aperture, ...scalars } = p.settings;
  const seed = state.post.seed;
  // `state.post` est partagé avec le rendu (dof.postParams) : mise à jour en place, pas de remplacement.
  Object.assign(state, scalars);
  Object.assign(state.aperture, aperture);
  Object.assign(state.post, post, { seed });
  // Looks et masque de saleté sont des références par nom : non rechargés, on revient au réglage neutre.
  state.lutName = ''; state.dirtName = '';
  dof.postProcessor.setLut(null);
  dof.postProcessor.setDirt(null, DIRT_SIZE);
  dof.postProcessor.setStock(getStock(state.post.stock) ?? null);
  dof.setPost(state.post);
  for (const k of ['explore', 'shoot'] as const) {
    const { target, ...rest } = p.orbits[k];
    Object.assign(orbits[k], rest);
    orbits[k].target.set(target[0], target[1], target[2]);
  }
  timeline.pause();
  timeline.recording = false;
  timeline.setShot(p.shot);
  awaitingScene = p.scene.name && p.scene.name !== sceneName ? p.scene.name : null;
  panel.sync();
  applyCameras();
}

const projectUi = createProjectUi(document.getElementById('project')!, {
  snapshot: () => ({
    text: serializeProject({ sceneName, settings: settingsOf(), orbits: { explore: orbitData(orbits.explore), shoot: orbitData(orbits.shoot) }, shot: timeline.shot }),
    fileName: projectFileName(sceneName),
  }),
  load(text) {
    if (exporter.running) throw new Error('Export en cours : projet non ouvert.');
    const { project, warnings } = parseProject(text, { settings: DEFAULT_SETTINGS, orbit: DEFAULT_ORBIT });
    applyProject(project);
    if (awaitingScene) warnings.unshift(`Scène « ${awaitingScene} » à déposer dans la fenêtre.`);
    return warnings;
  },
});

createShortcuts({
  timeline,
  locked: () => exporter.running,
  setMode(mode) { if (state.mode !== mode) { state.mode = mode; panel.sync(); applyCameras(); } },
  fps: () => state.fps,
  fNumber: () => state.fNumber,
  setFNumber(f) { state.fNumber = f; state.presetId = ''; panel.sync(); applyCameras(); },
  saveProject: () => { void projectUi.save(); },
  openProject: () => projectUi.open(),
  openExport: () => (document.querySelector('#export .open') as HTMLElement | null)?.click(),
}, document.getElementById('shortcuts')!);

document.getElementById('help-btn')?.addEventListener('click', () => document.getElementById('shortcuts')!.classList.toggle('hidden'));

// Télécommande : le téléphone envoie des commandes (src/remote/), l'application sur le Mac les applique.
void startRemoteHost({
  timeline,
  setMode(mode) { if (state.mode !== mode) { state.mode = mode; panel.sync(); applyCameras(); } },
  fps: () => state.fps,
  focal: () => state.focal,
  setFocal(mm) { state.focal = Math.round(mm * 10) / 10; state.presetId = ''; panel.sync(); applyCameras(); },
  fNumber: () => state.fNumber,
  setFNumber(f) { state.fNumber = f; state.presetId = ''; panel.sync(); applyCameras(); },
  focusM: () => state.focusM,
  setFocusM(m) { state.focusM = m; panel.sync(); applyCameras(); },
}, () => state.mode).then((host) => { if (host) createRemoteUi(document.getElementById('remote')!, host); });

// Mise au point par clic (picking sur les centres de splats pondérés par l'opacité).
let pickData: PickData | null = null;

/** Données de picking d'un asset : centres, et opacité / échelle si les données PLY brutes sont disponibles. */
function buildPickData(resource: pc.GSplatResource): PickData {
  const out: PickData = { centers: resource.centers };
  const raw = resource.gsplatData as unknown as { getProp?: (n: string) => ArrayLike<number> | null } | undefined;
  try {
    const op = raw?.getProp?.('opacity'), s0 = raw?.getProp?.('scale_0'), s1 = raw?.getProp?.('scale_1'), s2 = raw?.getProp?.('scale_2');
    if (op) out.opacity = Float32Array.from(op, (v) => 1 / (1 + Math.exp(-v))); // logit → opacité
    if (s0 && s1 && s2) out.sigma = Float32Array.from(s0, (v, i) => Math.exp((v + s1[i] + s2[i]) / 3)); // échelles en log
  } catch { /* formats compressés : centres seuls */ }
  return out;
}

function focusAt(clientX: number, clientY: number) {
  if (!pickData) return;
  const lens = dof.currentLens;
  if (!lens) return;
  // Pixels CSS → NDC dans le cadre de tournage (cadre centré, lettre-boîte).
  const box = canvas.getBoundingClientRect();
  const k = device.width / box.width;
  const r = dof.frameRect(lens.aspect);
  const px = (clientX - box.left) * k, py = (clientY - box.top) * k;
  const nx = ((px - r.x) / r.w) * 2 - 1;
  const ny = 1 - ((py - (device.height - r.y - r.h)) / r.h) * 2;
  if (Math.abs(nx) > 1 || Math.abs(ny) > 1) return; // clic dans les bandes noires
  const p11 = 1 / Math.tan((lens.fovV * Math.PI) / 360), p00 = p11 / lens.aspect;
  // ndc = p·x/(−z) − P02 (shift compris) ⇒ x/(−z) = (ndc + P02) / p.
  const local = new pc.Vec3((nx + lens.shiftNdc.x) / p00, (ny + lens.shiftNdc.y) / p11, -1).normalize();
  const dir = shoot.getRotation().transformVector(local);
  const fwd = shoot.forward, pos = shoot.getPosition();
  const tolAngle = (3 * 2) / (r.h * p11); // ≈ 3 px d'angle
  const z = pickDepth(pickData, [pos.x, pos.y, pos.z], [fwd.x, fwd.y, fwd.z], [dir.x, dir.y, dir.z], tolAngle);
  if (z === null) return;
  // Plan de netteté incliné : il doit passer par le point visé (pas seulement couper l'axe à sa profondeur).
  const tau = tiltGradient(lens.tiltDeg, lens.focalMm / 1000 / state.metersPerUnit);
  const d = focusThroughPoint(z, [local.x * z / -local.z, local.y * z / -local.z], tau);
  if (d === null) return;
  state.focusM = d * state.metersPerUnit;
  panel.sync();
  applyCameras();
}

// Chargement par glisser-déposer.
let current: pc.Entity | null = null;
let currentAsset: { asset: pc.Asset; url: string } | null = null;
async function loadFile(file: File) {
  hint.textContent = `Chargement de ${file.name}…`;
  const url = URL.createObjectURL(file);
  const asset = new pc.Asset(file.name, 'gsplat', { url, filename: file.name });
  app.assets.add(asset);
  asset.once('error', (err: string) => { hint.textContent = `Erreur : ${err}`; app.assets.remove(asset); URL.revokeObjectURL(url); });
  asset.once('load', () => {
    current?.destroy();
    // La scène précédente libère sa mémoire (splats GPU + données brutes), sinon chaque dépôt s'accumule.
    if (currentAsset) { currentAsset.asset.unload(); app.assets.remove(currentAsset.asset); URL.revokeObjectURL(currentAsset.url); }
    currentAsset = { asset, url };
    current = new pc.Entity(file.name);
    sceneName = file.name;
    const keepPose = awaitingScene === file.name;   // projet ouvert avant la scène : on garde sa pose
    awaitingScene = null;
    current.addComponent('gsplat', { asset });
    app.root.addChild(current);
    // Cadrage robuste : la AABB brute est faussée par les splats aberrants,
    // on utilise les percentiles 2 à 98 % des centres.
    const centers = (asset.resource as pc.GSplatResource | null)?.centers;
    pickData = asset.resource ? buildPickData(asset.resource as pc.GSplatResource) : null;
    if (keepPose) { panel.sync(); applyCameras(); }
    else if (centers && centers.length >= 3) {
      const n = centers.length / 3;
      const lo = new pc.Vec3(), hi = new pc.Vec3();
      const axis = new Float32Array(n);
      for (let k = 0; k < 3; k++) {
        for (let i = 0; i < n; i++) axis[i] = centers[i * 3 + k];
        axis.sort();
        const a = axis[Math.floor(n * 0.02)], b = axis[Math.floor(n * 0.98)];
        if (k === 0) { lo.x = a; hi.x = b; } else if (k === 1) { lo.y = a; hi.y = b; } else { lo.z = a; hi.z = b; }
      }
      const target = new pc.Vec3().add2(lo, hi).mulScalar(0.5);
      const dist = Math.max(0.5, hi.clone().sub(lo).length() * 0.9);
      for (const o of [orbits.explore, orbits.shoot]) {
        o.target.copy(target);
        o.dist = dist;
        // Les exports courants se regardent depuis -Z : on se place devant la scène, pas derrière.
        o.yaw = 180;
      }
      state.focusM = dist * state.metersPerUnit; // mise au point initiale sur la cible
      panel.sync();
      applyCameras();
    }
    hint.textContent = '';
    renderBurst = EXPLORE_SETTLE_FRAMES;
  });
  app.assets.load(asset);
}
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files[0];
  if (!f) return;
  if (f.name.toLowerCase().endsWith('.json')) void projectUi.openFile(f); else void loadFile(f);
});

// HUD : FPS lissés sur 0,5 s.
let frames = 0, last = performance.now();
app.on('update', (dt: number) => {
  // Export en cours : il tient le rendu (sous-rendus hors écran), ni lecture ni rendu d'aperçu.
  const exporting = exporter.tick();
  // Lecture / enregistrement de la timeline : seulement en mode tournage (la caméra d'exploration est libre).
  // Pendant l'export, le canvas garde la dernière image affichée.
  if (!exporting) {
    if (state.mode === 'shoot') {
      timeline.tick(dt, performance.now());
      state.post.seed = Math.floor(timeline.time * state.fps + 1e-6); // même image = même bruit
      dof.frame(dirty);
      dirty = false;
    } else {
      if (timeline.playing) timeline.pause();
      if (renderBurst > 0) { renderBurst--; app.renderNextFrame = true; }
    }
  }
  frames++;
  const now = performance.now();
  if (now - last >= 500) {
    const acc = exporting ? 'export en cours' : state.mode === 'shoot' ? `${dof.accumulated}/${state.samples} éch.` : renderBurst > 0 ? 'rendu' : 'au repos';
    const idle = !exporting && state.mode === 'explore' && renderBurst === 0;
    hud.textContent = idle ? 'au repos' : `${((frames * 1000) / (now - last)).toFixed(0)} fps · ${acc}`;
    frames = 0; last = now;
  }
});

// Handle de debug pour les tests visuels (dev uniquement).
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__splatcam = { pngWriter, folderSink, projectUi, applyProject, exporter, exportHost, state, orbits, applyCameras, dof, panel, device, canvas, timeline, shoot };
}

app.start();
