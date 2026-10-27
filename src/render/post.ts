// Chaîne optique et pellicule appliquée à l'image accumulée (HDR linéaire), puis sortie écran.
// Ordre : accumulation → exposition et gain des hautes lumières → bloom / halation →
// distorsion, aberration chromatique, vignettage → bruit capteur (ISO) et grain → tone mapping →
// sRGB → look (LUT .cube).
//
// Passes : (0) source RGBA16F ; pyramide de flou (6 niveaux, filtre « dual » : 5 prises à la descente,
// 8 à la montée, seuil doux au premier niveau) → U1 (bloom, tous les rayons) et U4 (halation, rayons
// larges) ; (B) composition plein cadre vers l'écran.

import * as pc from 'playcanvas';
import { atlasWidth, lutToAtlas, type Lut3D } from '../optics/lut';

export type ToneMap = 'none' | 'reinhard' | 'aces';
const TONE_ID: Record<ToneMap, number> = { none: 0, reinhard: 1, aces: 2 };

export interface PostParams {
  /** Exposition en diaphragmes (EV) ; multiplie l'image linéaire par 2^EV. */
  exposureEv: number;
  /** Gain des hautes lumières (1 = aucun) : fait dépasser 1,0 aux zones claires pour le bloom. */
  highlightGain: number;
  toneMap: ToneMap;
  /** Part d'énergie des hautes lumières renvoyée en halo (0 = aucun), seuil et étendue. */
  bloom: number;
  bloomThreshold: number;
  bloomRadius: number;
  /** Halation : halo rouge-orangé large autour des hautes lumières (0 = aucune). */
  halation: number;
  /** Vignettage naturel cos⁴ (0 à 1) et vignettage optique artistique (0 à 1). */
  vignetteNatural: number;
  vignetteOptical: number;
  /** Distorsion radiale : > 0 barillet, < 0 coussinet. */
  distortion: number;
  /** Aberration chromatique latérale (0 à 1 ; 1 = 0,6 % du rayon en bordure). */
  chromaticAberration: number;
  /** Sensibilité (0 = pas de bruit capteur). */
  iso: number;
  grain: number;
  /** Taille du grain en pixels. */
  grainSize: number;
  /** Intensité du look (LUT chargée) : 0 à 1. */
  lutAmount: number;
  /** Graine du bruit (numéro d'image) : même image = même bruit, export reproductible. */
  seed: number;
}

export const DEFAULT_POST: PostParams = {
  exposureEv: 0, highlightGain: 1, toneMap: 'aces',
  bloom: 0, bloomThreshold: 1, bloomRadius: 0.6, halation: 0,
  vignetteNatural: 0, vignetteOptical: 0, distortion: 0, chromaticAberration: 0,
  iso: 0, grain: 0, grainSize: 1.5, lutAmount: 1, seed: 0,
};

const LEVELS = 6;
/** Teinte de la halation (le rouge traverse le mieux le support de la pellicule). */
const HALATION_TINT = [1, 0.3, 0.1];

const SRC_WGSL = /* wgsl */ `
var accumTex: texture_2d<f32>;
var accumTexSampler: sampler;
uniform uExp: vec4f;   // exposition totale (normalisation des échantillons × 2^EV), gain des hautes lumières
varying uv0: vec2f;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  let p = vec2i(input.uv0 * vec2f(textureDimensions(accumTex)));
  var c = max(textureLoad(accumTex, p, 0).rgb * uniform.uExp.x, vec3f(0.0));
  let m = max(c.r, max(c.g, c.b));
  c = c * mix(1.0, uniform.uExp.y, smoothstep(0.6, 1.0, m));   // gain des hautes lumières
  output.color = vec4f(c, 1.0);
  return output;
}
`;

const DOWN_WGSL = /* wgsl */ `
var srcTex: texture_2d<f32>;
var srcTexSampler: sampler;
uniform uTexel: vec2f;   // taille d'un texel de la SOURCE
uniform uPre: vec4f;     // seuil, genou, 1 = premier niveau (seuil doux)
varying uv0: vec2f;

fn tap(uv: vec2f) -> vec3f { return textureSampleLevel(srcTex, srcTexSampler, uv, 0.0).rgb; }

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  let uv = input.uv0;
  let t = uniform.uTexel;
  // Filtre « dual » de descente : centre ×4 + 4 coins à ±1 texel, / 8.
  var c = tap(uv) * 4.0 + tap(uv + vec2f(-t.x, -t.y)) + tap(uv + vec2f(t.x, -t.y)) + tap(uv + vec2f(-t.x, t.y)) + tap(uv + vec2f(t.x, t.y));
  c = c / 8.0;
  if (uniform.uPre.z > 0.5) {
    // Seuil doux (genou quadratique) : ne garde que ce qui dépasse le seuil, progressivement.
    let l = max(c.r, max(c.g, c.b));
    let knee = max(uniform.uPre.y, 1e-4);
    let s = clamp(l - uniform.uPre.x + knee, 0.0, 2.0 * knee);
    let soft = s * s / (4.0 * knee);
    c = c * (max(soft, l - uniform.uPre.x) / max(l, 1e-5));
  }
  output.color = vec4f(c, 1.0);
  return output;
}
`;

const UP_WGSL = /* wgsl */ `
var lowTex: texture_2d<f32>;
var lowTexSampler: sampler;
var hiTex: texture_2d<f32>;
var hiTexSampler: sampler;
uniform uTexel: vec2f;   // taille d'un texel de lowTex (niveau plus grossier)
uniform uMix: f32;       // poids du niveau grossier : somme des poids = 1 (énergie conservée)
varying uv0: vec2f;

fn tap(uv: vec2f) -> vec3f { return textureSampleLevel(lowTex, lowTexSampler, uv, 0.0).rgb; }

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  let uv = input.uv0;
  let t = uniform.uTexel;
  // Filtre « dual » de montée (8 prises).
  let up = (tap(uv + vec2f(-2.0 * t.x, 0.0)) + tap(uv + vec2f(0.0, 2.0 * t.y)) + tap(uv + vec2f(2.0 * t.x, 0.0)) + tap(uv + vec2f(0.0, -2.0 * t.y))
    + 2.0 * (tap(uv + vec2f(-t.x, t.y)) + tap(uv + vec2f(t.x, t.y)) + tap(uv + vec2f(t.x, -t.y)) + tap(uv + vec2f(-t.x, -t.y)))) / 12.0;
  let hi = textureSampleLevel(hiTex, hiTexSampler, uv, 0.0).rgb;
  output.color = vec4f(mix(hi, up, uniform.uMix), 1.0);
  return output;
}
`;

// Composition. Les formules de vignettage, distorsion, bruit et tone mapping sont celles de
// optics/lens-effects.ts (testées) ; le look est celui de optics/lut.ts (applyLut).
const COMP_WGSL = /* wgsl */ `
var srcTex: texture_2d<f32>;
var srcTexSampler: sampler;
var bloomTex: texture_2d<f32>;
var bloomTexSampler: sampler;
var halaTex: texture_2d<f32>;
var halaTexSampler: sampler;
var lutTex: texture_2d<f32>;
var lutTexSampler: sampler;
uniform uA: vec4f;   // bloom, halation, k1 (distorsion), k2
uniform uB: vec4f;   // aberration chromatique, ajustement du cadre (barillet), rapport du cadre
uniform uC: vec4f;   // vignettage naturel, optique, tan(demi-champ H), tan(demi-champ V)
uniform uD: vec4f;   // coefficient de bruit capteur, grain, taille du grain (px), graine
uniform uE: vec4f;   // tone mapping (0 aucun, 1 Reinhard, 2 ACES), intensité du look, taille de la LUT, 1 = LUT chargée
uniform uTint: vec4f;
varying uv0: vec2f;

fn comp(uv: vec2f) -> vec3f {
  var o = textureSampleLevel(srcTex, srcTexSampler, uv, 0.0).rgb;
  if (uniform.uA.x > 0.0) { o += textureSampleLevel(bloomTex, bloomTexSampler, uv, 0.0).rgb * uniform.uA.x; }
  if (uniform.uA.y > 0.0) { o += textureSampleLevel(halaTex, halaTexSampler, uv, 0.0).rgb * uniform.uTint.xyz * uniform.uA.y; }
  return o;
}

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(p: vec2u, seed: u32, ch: u32) -> f32 {
  return f32(pcg(p.x + pcg(p.y + pcg(seed * 8u + ch)))) / 4294967295.0;
}
fn gauss(p: vec2u, seed: u32, ch: u32) -> f32 {
  let u1 = max(rnd(p, seed, ch * 2u), 1e-6);
  let u2 = rnd(p, seed, ch * 2u + 1u);
  return sqrt(-2.0 * log(u1)) * cos(6.2831853 * u2);
}
// Bruit gaussien interpolé sur un réseau (grain de taille > 1 px) ; ×1,4 pour compenser la variance perdue.
fn grainNoise(q: vec2f, seed: u32) -> f32 {
  let i = floor(q);
  let f = q - i;
  let u = f * f * (3.0 - 2.0 * f);
  let b = vec2u(i);
  let a00 = gauss(b, seed, 7u);
  let a10 = gauss(b + vec2u(1u, 0u), seed, 7u);
  let a01 = gauss(b + vec2u(0u, 1u), seed, 7u);
  let a11 = gauss(b + vec2u(1u, 1u), seed, 7u);
  return 1.4 * mix(mix(a00, a10, u.x), mix(a01, a11, u.x), u.y);
}

fn toneMap(c: vec3f, id: f32) -> vec3f {
  let x = max(c, vec3f(0.0));
  if (id < 0.5) { return min(x, vec3f(1.0)); }
  if (id < 1.5) { return x / (1.0 + x); }
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn srgbOetf(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn lutAt(r: i32, g: i32, b: i32, n: i32) -> vec3f { return textureLoad(lutTex, vec2i(r, g + b * n), 0).rgb; }

// Interpolation trilinéaire dans la bande (N × N²) : miroir de applyLut (optics/lut.ts).
fn applyLut(c: vec3f, n: i32) -> vec3f {
  let m = f32(n - 1);
  let p = clamp(c, vec3f(0.0), vec3f(1.0)) * m;
  let i0 = min(vec3i(floor(p)), vec3i(n - 2));
  let f = p - vec3f(i0);
  let c00 = mix(lutAt(i0.x, i0.y, i0.z, n), lutAt(i0.x + 1, i0.y, i0.z, n), f.x);
  let c10 = mix(lutAt(i0.x, i0.y + 1, i0.z, n), lutAt(i0.x + 1, i0.y + 1, i0.z, n), f.x);
  let c01 = mix(lutAt(i0.x, i0.y, i0.z + 1, n), lutAt(i0.x + 1, i0.y, i0.z + 1, n), f.x);
  let c11 = mix(lutAt(i0.x, i0.y + 1, i0.z + 1, n), lutAt(i0.x + 1, i0.y + 1, i0.z + 1, n), f.x);
  return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  let uv = input.uv0;
  let dims = vec2f(textureDimensions(srcTex));
  let aspect = uniform.uB.z;
  let norm = sqrt(aspect * aspect + 1.0);
  let ndc = uv * 2.0 - 1.0;
  let p = ndc * vec2f(aspect, 1.0) / norm;           // coordonnées de cadre centrées, coin = 1
  let r2 = dot(p, p);

  // Distorsion radiale (la sortie au rayon r lit la source à r·facteur) puis aberration chromatique latérale.
  let factor = (1.0 + uniform.uA.z * r2 + uniform.uA.w * r2 * r2) / uniform.uB.y;
  let uvs = (p * factor * norm / vec2f(aspect, 1.0)) * 0.5 + 0.5;
  let ca = uniform.uB.x;
  let mid = vec2f(0.5);
  var col = vec3f(comp(mid + (uvs - mid) * (1.0 + ca)).r, comp(uvs).g, comp(mid + (uvs - mid) * (1.0 - ca)).b);

  // Vignettage : naturel cos⁴θ (angle de champ du pixel) × optique (artistique).
  let tv = ndc * uniform.uC.zw;
  let t2 = dot(tv, tv);
  let nat = mix(1.0, 1.0 / ((1.0 + t2) * (1.0 + t2)), uniform.uC.x);
  let s = smoothstep(0.3, 1.1, sqrt(r2));
  col = col * nat * (1.0 - uniform.uC.y * s * s);

  // Bruit capteur (photons + lecture, indépendant par canal) puis grain de pellicule (gaussien, médiums).
  let px = vec2u(uv * dims);
  let seed = u32(uniform.uD.w);
  if (uniform.uD.x > 0.0) {
    col.r += gauss(px, seed, 0u) * uniform.uD.x * sqrt(0.18 * (max(col.r, 0.0) + 0.01));
    col.g += gauss(px, seed, 1u) * uniform.uD.x * sqrt(0.18 * (max(col.g, 0.0) + 0.01));
    col.b += gauss(px, seed, 2u) * uniform.uD.x * sqrt(0.18 * (max(col.b, 0.0) + 0.01));
  }
  if (uniform.uD.y > 0.0) {
    let g = grainNoise(uv * dims / max(uniform.uD.z, 0.5), seed);
    let lum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
    let y = pow(clamp(lum, 0.0, 1.0), 1.0 / 2.2);
    let w = clamp(4.0 * y * (1.0 - y), 0.15, 1.0);
    col = col * max(1.0 + uniform.uD.y * 0.35 * g * w, 0.0);
  }

  var o = srgbOetf(toneMap(col, uniform.uE.x));
  if (uniform.uE.w > 0.5 && uniform.uE.y > 0.0) { o = mix(o, applyLut(o, i32(uniform.uE.z)), uniform.uE.y); }
  output.color = vec4f(o, 1.0);
  return output;
}
`;

interface Target { tex: pc.Texture; rt: pc.RenderTarget }

export class PostProcessor {
  private readonly srcShader: pc.Shader;
  private readonly downShader: pc.Shader;
  private readonly upShader: pc.Shader;
  private readonly compShader: pc.Shader;
  private src: Target | null = null;
  private down: Target[] = [];   // niveaux 1..LEVELS (indice 0 = niveau 1)
  private up: Target[] = [];     // niveaux 1..LEVELS-1
  private w = 0;
  private h = 0;
  private lutTex: pc.Texture;
  private lutSize = 0;

  constructor(private readonly device: pc.GraphicsDevice) {
    const mk = (name: string, fragmentWGSL: string) => pc.ShaderUtils.createShader(device, {
      uniqueName: name, attributes: { aPosition: pc.SEMANTIC_POSITION }, vertexChunk: 'quadVS', fragmentWGSL,
    });
    this.srcShader = mk('SplatCamPostSrc', SRC_WGSL);
    this.downShader = mk('SplatCamPostDown', DOWN_WGSL);
    this.upShader = mk('SplatCamPostUp', UP_WGSL);
    this.compShader = mk('SplatCamPostComp', COMP_WGSL);
    this.lutTex = this.makeLutTexture(new Float32Array([0, 0, 0, 1]), 1, 1);
  }

  private makeLutTexture(data: Float32Array, w: number, h: number): pc.Texture {
    return new pc.Texture(this.device, {
      name: 'splatcam-lut', width: w, height: h, format: pc.PIXELFORMAT_RGBA32F, mipmaps: false,
      minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
      levels: [data],
    });
  }

  /** Charge un look (LUT 3D) ; null le retire. */
  setLut(lut: Lut3D | null): void {
    this.lutTex.destroy();
    if (!lut) { this.lutTex = this.makeLutTexture(new Float32Array([0, 0, 0, 1]), 1, 1); this.lutSize = 0; return; }
    this.lutTex = this.makeLutTexture(lutToAtlas(lut), atlasWidth(lut.size), lut.size * lut.size);
    this.lutSize = lut.size;
  }

  get hasLut(): boolean { return this.lutSize > 0; }

  private makeTarget(w: number, h: number, name: string): Target {
    const tex = new pc.Texture(this.device, {
      name, width: w, height: h, format: pc.PIXELFORMAT_RGBA16F, mipmaps: false,
      minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    return { tex, rt: new pc.RenderTarget({ colorBuffer: tex, depth: false, name }) };
  }

  private free(ts: Target[]): void { for (const t of ts) { t.rt.destroy(); t.tex.destroy(); } }

  private ensure(w: number, h: number): void {
    if (w === this.w && h === this.h && this.src) return;
    this.free(this.src ? [this.src] : []); this.free(this.down); this.free(this.up);
    this.src = this.makeTarget(w, h, 'splatcam-post-src');
    this.down = []; this.up = [];
    for (let k = 1; k <= LEVELS; k++) this.down.push(this.makeTarget(Math.max(1, w >> k), Math.max(1, h >> k), `splatcam-post-down-${k}`));
    for (let k = 1; k < LEVELS; k++) this.up.push(this.makeTarget(Math.max(1, w >> k), Math.max(1, h >> k), `splatcam-post-up-${k}`));
    this.w = w; this.h = h;
  }

  /**
   * Applique la chaîne à l'accumulateur et affiche dans `rect` (pixels écran).
   * `exposure` : facteur de normalisation des échantillons ; `aspect` et `tanV` : cadre et demi-champ vertical (tan).
   */
  run(accum: pc.Texture, w: number, h: number, exposure: number, aspect: number, tanV: number, p: PostParams, rect: pc.Vec4): void {
    this.ensure(w, h);
    const { scope } = this.device;
    const src = this.src!;
    const draw = (rt: pc.RenderTarget | null, shader: pc.Shader, r?: pc.Vec4) => pc.drawQuadWithShader(this.device, rt, shader, r);

    scope.resolve('accumTex').setValue(accum);
    scope.resolve('uExp').setValue([exposure * Math.pow(2, p.exposureEv), p.highlightGain, 0, 0]);
    draw(src.rt, this.srcShader);

    const useGlow = p.bloom > 0 || p.halation > 0;
    if (useGlow) {
      // Descente avec seuil doux au premier niveau.
      for (let k = 0; k < LEVELS; k++) {
        const from = k === 0 ? src : this.down[k - 1];
        scope.resolve('srcTex').setValue(from.tex);
        scope.resolve('uTexel').setValue([1 / from.tex.width, 1 / from.tex.height]);
        scope.resolve('uPre').setValue([p.bloomThreshold, 0.5 * p.bloomThreshold, k === 0 ? 1 : 0, 0]);
        draw(this.down[k].rt, this.downShader);
      }
      // Montée : U_k = (1 − m)·D_k + m·flou(U_{k+1}) ; U_LEVELS = D_LEVELS.
      for (let k = LEVELS - 1; k >= 1; k--) {
        const low = k === LEVELS - 1 ? this.down[LEVELS - 1] : this.up[k];
        scope.resolve('lowTex').setValue(low.tex);
        scope.resolve('hiTex').setValue(this.down[k - 1].tex);
        scope.resolve('uTexel').setValue([1 / low.tex.width, 1 / low.tex.height]);
        scope.resolve('uMix').setValue(p.bloomRadius);
        draw(this.up[k - 1].rt, this.upShader);
      }
    }

    const dist = p.distortion;
    scope.resolve('srcTex').setValue(src.tex);
    scope.resolve('bloomTex').setValue(useGlow ? this.up[0].tex : src.tex);
    scope.resolve('halaTex').setValue(useGlow ? this.up[3].tex : src.tex);
    scope.resolve('lutTex').setValue(this.lutTex);
    scope.resolve('uA').setValue([p.bloom, p.halation, dist, 0]);
    scope.resolve('uB').setValue([p.chromaticAberration * 0.006, Math.max(1, 1 + dist), aspect, 0]);
    scope.resolve('uC').setValue([p.vignetteNatural, p.vignetteOptical, tanV * aspect, tanV]);
    const iso = p.iso > 0 ? 0.03 * Math.sqrt(p.iso / 800) : 0;
    scope.resolve('uD').setValue([iso, p.grain, p.grainSize, p.seed]);
    scope.resolve('uE').setValue([TONE_ID[p.toneMap], p.lutAmount, this.lutSize, this.lutSize > 0 ? 1 : 0]);
    scope.resolve('uTint').setValue([HALATION_TINT[0], HALATION_TINT[1], HALATION_TINT[2], 0]);
    draw(null, this.compShader, rect);
  }
}
