// Profondeur de champ par accumulation multi-échantillons (HDR linéaire).
//
// Chaque sous-rendu : la caméra de tournage est décalée dans le plan de l'objectif (échantillon
// d'ouverture, Halton) et sa projection est cisaillée (voir optics/dof.ts) pour que le plan de
// netteté reste fixe. Le résultat linéaire (RGBA16F) est moyenné dans un accumulateur RGBA32F
// (ping-pong : accum' = mix(accum, sous-rendu, 1/(k+1))), puis affiché avec l'encodage sRGB.

import * as pc from 'playcanvas';
import { apertureDiameter, apertureScale, shearTerm } from '../optics/dof';
import { diskSample } from '../optics/sampling';

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
}

// Passe d'accumulation : moyenne glissante, un échantillon à la fois.
const ACCUM_WGSL = /* wgsl */ `
var sceneTex: texture_2d<f32>;
var sceneTexSampler: sampler;
var prevTex: texture_2d<f32>;
var prevTexSampler: sampler;
uniform weight: f32;   // 1 / (k + 1) : poids du nouvel échantillon
varying uv0: vec2f;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  let p = vec2i(input.uv0 * vec2f(textureDimensions(sceneTex)));
  output.color = mix(textureLoad(prevTex, p, 0), textureLoad(sceneTex, p, 0), uniform.weight);
  return output;
}
`;

// Affichage : exposition puis encodage sRGB (le tone mapping / look viendra en M6).
const PRESENT_WGSL = /* wgsl */ `
var accumTex: texture_2d<f32>;
var accumTexSampler: sampler;
uniform exposure: f32;
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
  private readonly screenRect = new pc.Vec4();
  private inSubRender = false;
  private presentNow = false;

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

  setLens(lens: LensParams): void { this.lens = lens; }

  get currentLens(): LensParams | null { return this.lens; }

  private makeTarget(w: number, h: number, format: number, name: string) {
    const tex = new pc.Texture(this.device, {
      name, width: w, height: h, format, mipmaps: false,
      minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
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
    const scene = this.makeTarget(w, h, pc.PIXELFORMAT_RGBA16F, 'splatcam-scene');
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
    const base = cam.getPosition().clone();
    const right = cam.right.clone(), up = cam.up.clone();
    const mpu = lens.metersPerUnit;
    const focusU = lens.focusM / mpu;
    // Rayon d'ouverture en unités de scène, mis à l'échelle pour la CoC exacte (voir apertureScale).
    const focusMm = lens.focusM * 1000;
    const radiusU = (apertureDiameter(lens.focalMm, lens.fNumber) / 2) * (focusMm > lens.focalMm ? apertureScale(lens.focalMm, focusMm) : 1) / 1000 / mpu;

    // Éléments diagonaux de la projection (setPerspective, fov vertical) : P11 = 1/tan(fov/2), P00 = P11/aspect.
    const p11 = 1 / Math.tan((lens.fovV * Math.PI) / 360), p00 = p11 / lens.aspect;

    this.inSubRender = true;
    for (let i = 0; i < budget; i++) {
      const [sx, sy] = diskSample(this.count);
      const ox = sx * radiusU, oy = sy * radiusU;
      cam.setPosition(base.clone().add(right.clone().mulScalar(ox)).add(up.clone().mulScalar(oy)));
      // Cisaillement : PlayCanvas écrit projectionOffset dans P02 / P12 de la matrice de projection.
      cc.projectionOffset = new pc.Vec2(shearTerm(ox, p00, focusU), shearTerm(oy, p11, focusU));
      this.presentNow = i === budget - 1;
      this.app.render();
    }
    this.inSubRender = false;
    cc.projectionOffset = new pc.Vec2(0, 0);
    cam.setPosition(base);
  }

  /** Dans le rendu de l'image : accumule le sous-rendu, puis affiche si c'est le dernier. */
  private onPostRender(): void {
    if (!this.inSubRender || !this.sceneRT) return;
    const { scope } = this.device;
    const prev = this.accum[this.cur], next = this.accum[1 - this.cur];
    scope.resolve('sceneTex').setValue(this.sceneRT.colorBuffer);
    scope.resolve('prevTex').setValue(prev.tex);
    scope.resolve('weight').setValue(1 / (this.count + 1));
    pc.drawQuadWithShader(this.device, next.rt, this.accumShader);
    this.cur = 1 - this.cur;
    this.count++;
    if (this.presentNow) {
      scope.resolve('accumTex').setValue(this.accum[this.cur].tex);
      scope.resolve('exposure').setValue(this.exposure);
      pc.drawQuadWithShader(this.device, null, this.presentShader, this.screenRect);
    }
  }
}
