import * as pc from 'playcanvas';
import { DEFAULT_SENSOR_ID, getSensor, rad2deg, sensorFov } from './optics/sensor';
import { createPanel, type PanelState } from './ui/panel';

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
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
window.addEventListener('resize', () => { app.resizeCanvas(); applyCameras(); });

// État réglable depuis le panneau.
const state: PanelState = { mode: 'explore', sensorId: DEFAULT_SENSOR_ID, focal: 35, metersPerUnit: 1 };

// Caméra de fond : efface tout l'écran (les bandes noires du cadre de tournage).
const bg = new pc.Entity('background');
bg.addComponent('camera', { clearColor: new pc.Color(0, 0, 0), layers: [], priority: 0 });
app.root.addChild(bg);

// Deux caméras indépendantes : exploration (libre, debug) et tournage (capteur + focale réels).
const explore = new pc.Entity('explore');
explore.addComponent('camera', { clearColor: new pc.Color(0.07, 0.07, 0.07), fov: 50, nearClip: 0.05, farClip: 1000, priority: 1 });
app.root.addChild(explore);
const shoot = new pc.Entity('shoot');
shoot.addComponent('camera', { clearColor: new pc.Color(0.07, 0.07, 0.07), nearClip: 0.05, farClip: 1000, priority: 1 });
app.root.addChild(shoot);

// Orbite de debug : angles + distance autour d'une cible (unités de scène), un état par caméra.
interface Orbit { yaw: number; pitch: number; dist: number; target: pc.Vec3 }
const newOrbit = (): Orbit => ({ yaw: 0, pitch: -15, dist: 4, target: new pc.Vec3(0, 0, 0) });
const orbits = { explore: newOrbit(), shoot: newOrbit() };
const cams = { explore, shoot };

function poseCamera(mode: 'explore' | 'shoot') {
  const o = orbits[mode], cam = cams[mode];
  cam.setPosition(o.target);
  cam.setEulerAngles(o.pitch, o.yaw, 0);
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

  // Cadre : on remplit le canvas en conservant le rapport du capteur.
  const ca = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const sa = sensor.width / sensor.height;
  const w = ca > sa ? sa / ca : 1, h = ca > sa ? 1 : ca / sa;
  const rect = new pc.Vec4((1 - w) / 2, (1 - h) / 2, w, h);
  sc.rect = rect;
  sc.scissorRect = rect;

  poseCamera('explore');
  poseCamera('shoot');
  panel.show(fov, orbits[state.mode].dist * state.metersPerUnit);
}

const panel = createPanel(state, applyCameras);

let drag: { x: number; y: number; pan: boolean } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
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
  const o = orbits[state.mode];
  o.dist = Math.max(0.05, o.dist * Math.exp(e.deltaY * 0.001));
  applyCameras();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLElement && e.target.matches('input, select')) return;
  if (e.key === 'e') { state.mode = 'explore'; panel.sync(); applyCameras(); }
  if (e.key === 't') { state.mode = 'shoot'; panel.sync(); applyCameras(); }
});

// Chargement par glisser-déposer.
let current: pc.Entity | null = null;
async function loadFile(file: File) {
  hint.textContent = `Chargement de ${file.name}…`;
  const url = URL.createObjectURL(file);
  const asset = new pc.Asset(file.name, 'gsplat', { url, filename: file.name });
  app.assets.add(asset);
  asset.once('error', (err: string) => { hint.textContent = `Erreur : ${err}`; });
  asset.once('load', () => {
    current?.destroy();
    current = new pc.Entity(file.name);
    current.addComponent('gsplat', { asset });
    app.root.addChild(current);
    // Cadrage robuste : la AABB brute est faussée par les splats aberrants,
    // on utilise les percentiles 2 à 98 % des centres.
    const centers = (asset.resource as pc.GSplatResource | null)?.centers;
    if (centers && centers.length >= 3) {
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
      applyCameras();
    }
    hint.textContent = '';
  });
  app.assets.load(asset);
}
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (f) void loadFile(f);
});

// HUD : FPS lissés sur 0,5 s.
let frames = 0, last = performance.now();
app.on('update', () => {
  frames++;
  const now = performance.now();
  if (now - last >= 500) {
    hud.textContent = `${((frames * 1000) / (now - last)).toFixed(0)} fps · ${device.deviceType}`;
    frames = 0; last = now;
  }
});

applyCameras();
app.start();
