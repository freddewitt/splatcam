import * as pc from 'playcanvas';

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
window.addEventListener('resize', () => app.resizeCanvas());

const camera = new pc.Entity('camera');
camera.addComponent('camera', { clearColor: new pc.Color(0.07, 0.07, 0.07), fov: 50, nearClip: 0.05, farClip: 1000 });
app.root.addChild(camera);

// Caméra d'orbite de debug : angles + distance autour d'une cible.
const orbit = { yaw: 0, pitch: -15, dist: 4, target: new pc.Vec3(0, 0, 0) };
function updateCamera() {
  camera.setPosition(orbit.target);
  camera.setEulerAngles(orbit.pitch, orbit.yaw, 0);
  camera.translateLocal(0, 0, orbit.dist);
}
updateCamera();

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
  if (drag.pan) {
    const k = orbit.dist * 0.0015;
    orbit.target.add(camera.right.clone().mulScalar(-dx * k)).add(camera.up.clone().mulScalar(dy * k));
  } else {
    orbit.yaw -= dx * 0.3;
    orbit.pitch = Math.max(-89, Math.min(89, orbit.pitch - dy * 0.3));
  }
  updateCamera();
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.dist = Math.max(0.05, orbit.dist * Math.exp(e.deltaY * 0.001));
  updateCamera();
}, { passive: false });

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
    // Cadrage sur la boîte englobante de la scène.
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
      orbit.target.add2(lo, hi).mulScalar(0.5);
      orbit.dist = Math.max(0.5, hi.clone().sub(lo).length() * 0.9);
      // Les exports courants regardent vers +Z : on se place devant la scène, pas derrière.
      orbit.yaw = 180;
      updateCamera();
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

app.start();
