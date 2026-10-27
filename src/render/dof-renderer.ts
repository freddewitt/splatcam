// Profondeur de champ par accumulation multi-échantillons (HDR linéaire).
//
// Chaque sous-rendu : la caméra de tournage est décalée dans le plan de l'objectif (échantillon
// d'ouverture, Halton, voir optics/aperture.ts) et sa projection est cisaillée (voir optics/dof.ts)
// pour que le plan de netteté reste fixe. Le résultat linéaire (RGBA16F) est SOMMÉ dans un
// accumulateur RGBA32F (ping-pong) avec un poids par pixel (masque d'ouverture : cat-eye, swirl,
// lames), puis divisé par le nombre d'échantillons à l'affichage (encodage sRGB). Diviser par le
// nombre d'échantillons, et non par la somme des poids, donne le vignettage mécanique du cat-eye.

import * as pc from 'playcanvas';
import { apertureDiameter, apertureScale, shearTerm } from '../optics/dof';
import { sampleTime, type ExposurePlan } from '../optics/camera-defects';
import { isTilted, tiltGradient, tiltWarp, type Tilt } from '../optics/tilt';
import { ApertureSampler, DEFAULT_APERTURE, apertureMask, type ApertureShape } from '../optics/aperture';

/** Objectif à un instant donné du plan (flou de mouvement : zoom, map, gate weave). */
export interface LensSample {
  fovV: number;
  focalMm: number;
  focusM: number;
  /** Décalage d'image supplémentaire (gate weave), NDC. */
  extraShiftNdc?: { x: number; y: number };
}

/** Exposition étalée dans le temps : chaque sous-rendu voit la caméra, la map et le zoom à son propre instant. */
export interface Motion {
  plan: ExposurePlan;
  /** Place la caméra à l'instant t + u (s) et renvoie l'objectif à cet instant. */
  apply(u: number): LensSample;
  /** Remet la caméra dans l'état d'avant le flou de mouvement. */
  restore(): void;
}

export interface LensParams {
  /** Champ vertical, degrés. */
  fovV: number;
  aspect: number;
  /** Focale (mm) et ouverture f/N. */
  focalMm: number;
  fNumber: number;
  /** Distance de mise au point, en mètres. */
  focusM: number;
  /** Mètres par unité de scène. */
  metersPerUnit: number;
  /** Forme d'ouverture (bokeh). */
  aperture: ApertureShape;
  /** Shift de l'objectif en NDC (2 · décalage_mm / taille_capteur_mm) : > 0 = cadre vers la droite / le haut. */
  shiftNdc: { x: number; y: number };
  /** Tilt / swing de l'objectif (°) : plan de netteté incliné. */
  tiltDeg: Tilt;
}

// Passe d'accumulation : somme pondérée, un échantillon à la fois.
// La partie « masque » est le miroir de `apertureMask` (src/optics/aperture.ts, testé) : garder les deux alignés.
const ACCUM_WGSL = /* wgsl */ `
var sceneTex: texture_2d<f32>;
var sceneTexSampler: sampler;
var prevTex: texture_2d<f32>;
var prevTexSampler: sampler;
uniform uSample: vec2f;   // décalage normalisé u dans le disque unité (avant squeeze)
uniform uShape: vec4f;    // lames, arrondi, rotation (rad), cat-eye
uniform uField: vec4f;    // swirl (rad), rapport du cadre, 1 = premier échantillon (ignore prevTex), 1 = tilt actif
uniform uRS: vec4f;       // rolling shutter : instant du sous-rendu u (s), lecture ρ (s), fenêtre w (s), 1 = actif
uniform uWarp: vec4f;     // tilt : m00, m01, m10, m11 de I − o·τᵀ (voir optics/tilt.ts)
uniform uProj: vec4f;     // tilt : P00, P11, shift NDC x, y
varying uv0: vec2f;

const PI: f32 = 3.14159265;

// Frontière d'un polygone régulier (circonrayon 1, sommet en haut), arrondie par 'roundness'.
fn bladeBoundary(angle: f32, n: f32, roundness: f32) -> f32 {
  let wedge = 2.0 * PI / n;
  let x = angle - PI * 0.5;
  let a = ((x % wedge) + wedge * 1.5) % wedge - wedge * 0.5;
  let flat = cos(PI / n) / cos(wedge * 0.5 - abs(a));
  return flat + (1.0 - flat) * roundness;
}

// 1 si le décalage u passe l'ouverture effective au point du champ f (|f| = 1 dans un coin).
fn apertureWeight(u: vec2f, f: vec2f) -> f32 {
  let rho = min(1.0, length(f));
  let phi = uniform.uField.x * rho * rho;                       // swirl : repère tourné de φ(ρ)
  let c = cos(phi); let s = sin(phi);
  let w = vec2f(c * u.x + s * u.y, -s * u.x + c * u.y);
  let blades = uniform.uShape.x;
  if (blades >= 3.0) {
    if (length(w) > bladeBoundary(atan2(w.y, w.x) - uniform.uShape.z, blades, uniform.uShape.y)) { return 0.0; }
  } else if (length(w) > 1.0) { return 0.0; }
  if (uniform.uShape.w > 0.0 && rho > 1e-6) {                   // cat-eye : citron, axe court le long du champ
    let d = 1.6 * uniform.uShape.w * rho * rho;
    let fh = f / rho;
    let along = dot(w, fh);
    let across = -w.x * fh.y + w.y * fh.x;
    if (length(vec2f(along - d * 0.5, across)) > 1.0 || length(vec2f(along + d * 0.5, across)) > 1.0) { return 0.0; }
  }
  return 1.0;
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  let p = vec2i(input.uv0 * vec2f(textureDimensions(sceneTex)));
  let aspect = uniform.uField.y;
  // uv0.y croît vers le BAS de l'image (ligne 0 = haut) alors que u.y est « haut caméra » : on inverse y.
  let f = (input.uv0 * 2.0 - 1.0) * vec2f(aspect, -1.0) / sqrt(aspect * aspect + 1.0);
  var w = apertureWeight(uniform.uSample, f);
  if (uniform.uRS.w > 0.5) {
    // Rolling shutter : la ligne uv0.y (0 = haut) est exposée sur [ρ·y, ρ·y + w] ; miroir de rowAccepts (optics/camera-defects.ts).
    let rowStart = uniform.uRS.y * input.uv0.y;
    if (uniform.uRS.x < rowStart || uniform.uRS.x >= rowStart + uniform.uRS.z) { w = 0.0; }
  }
  let prev = select(textureLoad(prevTex, p, 0), vec4f(0.0), uniform.uField.z > 0.5);
  var rgb = textureLoad(sceneTex, p, 0).rgb;
  if (uniform.uField.w > 0.5) {
    // Tilt (Scheimpflug) : le sous-rendu, cisaillé pour le plan perpendiculaire, voit le plan incliné
    // décalé. On relit l'image aux tangentes v' = (I − o·τᵀ)·v (v = (ndc + shift) / P, ndc = P·v − shift).
    let pr = uniform.uProj.xy;
    let sh = uniform.uProj.zw;
    let ndc = vec2f(input.uv0.x * 2.0 - 1.0, 1.0 - input.uv0.y * 2.0);
    let v = (ndc + sh) / pr;
    let m = uniform.uWarp;
    let vo = vec2f(m.x * v.x + m.y * v.y, m.z * v.x + m.w * v.y);
    let uvo = vec2f((pr.x * vo.x - sh.x) * 0.5 + 0.5, 0.5 - (pr.y * vo.y - sh.y) * 0.5);
    rgb = textureSampleLevel(sceneTex, sceneTexSampler, uvo, 0.0).rgb;
  }
  let scene = select(vec4f(0.0), vec4f(rgb, 1.0), w > 0.5);
  output.color = prev + scene;
  return output;
}
`;

// Affichage : exposition puis encodage sRGB (le tone mapping / look viendra en M6).
const PRESENT_WGSL = /* wgsl */ `
var accumTex: texture_2d<f32>;
var accumTexSampler: sampler;
uniform exposure: f32;     // exposition × 1 / (nombre d'échantillons × acceptation au centre)
varying uv0: vec2f;

fn srgbOetf(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  let p = vec2i(input.uv0 * vec2f(textureDimensions(accumTex)));
  let c = max(textureLoad(accumTex, p, 0).rgb * uniform.exposure, vec3f(0.0));
  output.color = vec4f(srgbOetf(min(c, vec3f(1.0))), 1.0);
  return output;
}
`;

export class DofRenderer {
  /** Échantillons par image en mouvement (aperçu). */
  previewSamples = 4;
  /** Échantillons visés à l'arrêt (raffinement progressif). */
  targetSamples = 64;
  /** Échantillons ajoutés par image pendant le raffinement. */
  stepSamples = 4;
  exposure = 1;
  /** Flou de mouvement / rolling shutter / gate weave ; null = image instantanée. */
  motion: Motion | null = null;

  private readonly device: pc.GraphicsDevice;
  private readonly accumShader: pc.Shader;
  private readonly presentShader: pc.Shader;
  private sceneRT: pc.RenderTarget | null = null;
  private accum: { tex: pc.Texture; rt: pc.RenderTarget }[] = [];
  private cur = 0;
  private count = 0;
  private w = 0;
  private h = 0;
  private lens: LensParams | null = null;
  private sampler = new ApertureSampler(DEFAULT_APERTURE);
  private samplerKey = JSON.stringify(DEFAULT_APERTURE);
  /** Fraction des échantillons acceptés au centre du champ (lames) : normalise l'exposition. */
  private centerAcceptance = 1;
  /** Échantillon courant (masque lu par l'accumulation). */
  private cur_u: [number, number] = [0, 0];
  /** Tilt de l'échantillon courant : matrice I − o·τᵀ et paramètres de projection (lus par l'accumulation). */
  private warp = { on: false, m: [1, 0, 0, 1] as number[], proj: [1, 1, 0, 0] as number[] };
  private readonly screenRect = new pc.Vec4();
  private inSubRender = false;
  private presentNow = false;
  /** Instant du sous-rendu courant et plan d'exposition (lus par l'accumulation). */
  private rs = { u: 0, readout: 0, window: 0, on: false };
  /** Fraction des sous-rendus acceptée par ligne (rolling shutter) : normalise l'exposition. */
  private rsAcceptance = 1;

  constructor(private readonly app: pc.AppBase, private readonly camera: pc.Entity) {
    this.device = app.graphicsDevice;
    const mk = (name: string, fragmentWGSL: string) => pc.ShaderUtils.createShader(this.device, {
      uniqueName: name,
      attributes: { aPosition: pc.SEMANTIC_POSITION },
      vertexChunk: 'quadVS',
      fragmentWGSL,
    });
    this.accumShader = mk('SplatCamAccum', ACCUM_WGSL);
    this.presentShader = mk('SplatCamPresent', PRESENT_WGSL);
    app.on('postrender', () => this.onPostRender());
  }

  /** Échantillons accumulés depuis le dernier reset. */
  get accumulated(): number { return this.count; }

  /** Invalide l'accumulation (caméra, objectif ou scène modifiés). */
  reset(): void { this.count = 0; }

  setLens(lens: LensParams): void {
    this.lens = lens;
    const key = JSON.stringify(lens.aperture);
    if (key !== this.samplerKey) {
      this.samplerKey = key;
      this.sampler = new ApertureSampler(lens.aperture);
      // Acceptation au centre : les lames éliminent des échantillons même sans vignettage ;
      // l'ouverture f/N est définie à surface équivalente, donc on renormalise.
      const n = 4096;
      let ok = 0;
      for (let i = 0; i < n; i++) if (apertureMask(this.sampler.sample(i), [0, 0], lens.aperture)) ok++;
      this.centerAcceptance = ok / n;
      this.count = 0;
    }
  }

  get currentLens(): LensParams | null { return this.lens; }

  private makeTarget(w: number, h: number, format: number, name: string, filter: number = pc.FILTER_NEAREST) {
    const tex = new pc.Texture(this.device, {
      name, width: w, height: h, format, mipmaps: false,
      minFilter: filter, magFilter: filter,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    return { tex, rt: new pc.RenderTarget({ colorBuffer: tex, depth: false, name }) };
  }

  /** (Re)crée les cibles à la taille du cadre affiché (pixels). */
  private ensureTargets(w: number, h: number): void {
    if (w === this.w && h === this.h && this.sceneRT) return;
    this.sceneRT?.destroy();
    this.sceneRT?.colorBuffer?.destroy();
    for (const a of this.accum) { a.rt.destroy(); a.tex.destroy(); }
    const scene = this.makeTarget(w, h, pc.PIXELFORMAT_RGBA16F, 'splatcam-scene', pc.FILTER_LINEAR);
    this.sceneRT = scene.rt;
    this.accum = [0, 1].map((i) => this.makeTarget(w, h, pc.PIXELFORMAT_RGBA32F, `splatcam-accum-${i}`));
    this.w = w; this.h = h; this.count = 0; this.cur = 0;
    this.camera.camera!.renderTarget = this.sceneRT;
  }

  /** Cadre (pixels écran) au rapport `aspect`, centré et inscrit dans le canvas. */
  frameRect(aspect: number): { x: number; y: number; w: number; h: number } {
    const cw = this.device.width, ch = this.device.height;
    const w = Math.max(2, Math.round(cw / ch > aspect ? ch * aspect : cw));
    const h = Math.max(2, Math.round(cw / ch > aspect ? ch : cw / aspect));
    return { x: Math.round((cw - w) / 2), y: Math.round((ch - h) / 2), w, h };
  }

  /** Débranche la caméra de la cible HDR (retour en mode exploration). */
  detach(): void {
    const cc = this.camera.camera as unknown as { renderTarget: pc.RenderTarget | null };
    cc.renderTarget = null;
    this.camera.camera!.projectionOffset = new pc.Vec2(0, 0);
  }

  /**
   * Un tour de boucle en mode tournage. `dirty` : quelque chose a changé depuis la dernière image
   * (on repart de zéro avec l'aperçu). Rend jusqu'à `previewSamples` (en mouvement) ou `stepSamples`
   * (raffinement) sous-rendus et affiche l'accumulateur.
   */
  frame(dirty: boolean): void {
    const lens = this.lens;
    if (!lens) return;
    const r = this.frameRect(lens.aspect);
    this.ensureTargets(r.w, r.h);
    this.screenRect.set(r.x, r.y, r.w, r.h);
    if (dirty) this.count = 0;

    const budget = dirty ? this.previewSamples : Math.min(this.stepSamples, this.targetSamples - this.count);
    if (budget <= 0) return; // image terminée : l'écran garde la dernière image présentée

    const cam = this.camera, cc = cam.camera!;
    const basePos = cam.getPosition().clone();
    const baseRight = cam.right.clone(), baseUp = cam.up.clone();
    const mpu = lens.metersPerUnit;
    const motion = this.motion;
    this.rsAcceptance = motion?.plan.acceptance ?? 1;

    this.inSubRender = true;
    for (let i = 0; i < budget; i++) {
      // Instant du sous-rendu (flou de mouvement) : caméra, map et zoom à cet instant.
      let base = basePos, right = baseRight, up = baseUp;
      let focalMm = lens.focalMm, focusM = lens.focusM, fovV = lens.fovV, shX = lens.shiftNdc.x, shY = lens.shiftNdc.y;
      const u = motion ? sampleTime(this.count, motion.plan) : 0;
      if (motion) {
        const s = motion.apply(u);
        focalMm = s.focalMm; focusM = s.focusM; fovV = s.fovV;
        shX += s.extraShiftNdc?.x ?? 0; shY += s.extraShiftNdc?.y ?? 0;
        base = cam.getPosition().clone(); right = cam.right.clone(); up = cam.up.clone();
      }
      this.rs = { u, readout: motion?.plan.readout ?? 0, window: motion?.plan.window ?? 0, on: (motion?.plan.readout ?? 0) > 0 };

      const focusU = focusM / mpu;
      // Rayon d'ouverture en unités de scène, mis à l'échelle pour la CoC exacte (voir apertureScale).
      const focusMm = focusM * 1000;
      const radiusU = (apertureDiameter(focalMm, lens.fNumber) / 2) * (focusMm > focalMm ? apertureScale(focalMm, focusMm) : 1) / 1000 / mpu;
      // Éléments diagonaux de la projection (setPerspective, fov vertical) : P11 = 1/tan(fov/2), P00 = P11/aspect.
      const p11 = 1 / Math.tan((fovV * Math.PI) / 360), p00 = p11 / lens.aspect;
      // Tilt : gradient τ du plan de netteté, en 1 / unité de scène (la focale est convertie en unités de scène).
      const tilted = isTilted(lens.tiltDeg);
      const tau = tiltGradient(lens.tiltDeg, focalMm / 1000 / mpu);

      // Échantillon d'ouverture : décalage de caméra (squeeze appliqué) et décalage normalisé pour le masque.
      this.cur_u = this.sampler.sample(this.count);
      const [dx, dy] = this.sampler.offset(this.count);
      const ox = dx * radiusU, oy = dy * radiusU;
      cam.setPosition(base.clone().add(right.clone().mulScalar(ox)).add(up.clone().mulScalar(oy)));
      // Cisaillement : PlayCanvas écrit projectionOffset dans P02 / P12 de la matrice de projection
      // (ndc = p·x/(−z) − P02). Le shift de l'objectif s'ajoute : cadre déplacé sans bouger le plan de netteté.
      cc.projectionOffset = new pc.Vec2(shearTerm(ox, p00, focusU) + shX, shearTerm(oy, p11, focusU) + shY);
      this.warp = {
        on: tilted,
        m: tilted ? tiltWarp([ox, oy], tau) : [1, 0, 0, 1],
        proj: [p00, p11, shX, shY],
      };
      this.presentNow = i === budget - 1;
      this.app.render();
    }
    motion?.restore();
    this.inSubRender = false;
    cc.projectionOffset = new pc.Vec2(0, 0);
    cam.setPosition(basePos);
  }

  /** Dans le rendu de l'image : accumule le sous-rendu, puis affiche si c'est le dernier. */
  private onPostRender(): void {
    if (!this.inSubRender || !this.sceneRT) return;
    const { scope } = this.device;
    const prev = this.accum[this.cur], next = this.accum[1 - this.cur];
    scope.resolve('sceneTex').setValue(this.sceneRT.colorBuffer);
    scope.resolve('prevTex').setValue(prev.tex);
    const ap = this.lens!.aperture;
    scope.resolve('uSample').setValue(this.cur_u);
    scope.resolve('uShape').setValue([ap.blades, ap.roundness, (ap.rotationDeg * Math.PI) / 180, ap.catEye]);
    scope.resolve('uField').setValue([(ap.swirlDeg * Math.PI) / 180, this.lens!.aspect, this.count === 0 ? 1 : 0, this.warp.on ? 1 : 0]);
    scope.resolve('uRS').setValue([this.rs.u, this.rs.readout, this.rs.window, this.rs.on ? 1 : 0]);
    scope.resolve('uWarp').setValue(this.warp.m);
    scope.resolve('uProj').setValue(this.warp.proj);
    pc.drawQuadWithShader(this.device, next.rt, this.accumShader);
    this.cur = 1 - this.cur;
    this.count++;
    if (this.presentNow) {
      scope.resolve('accumTex').setValue(this.accum[this.cur].tex);
      scope.resolve('exposure').setValue(this.exposure / (this.count * this.centerAcceptance * this.rsAcceptance));
      pc.drawQuadWithShader(this.device, null, this.presentShader, this.screenRect);
    }
  }
}
