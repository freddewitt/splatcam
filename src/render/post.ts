// Chaîne optique et pellicule appliquée à l'image accumulée (HDR linéaire), puis sortie écran.
// Ordre : accumulation → exposition et gain des hautes lumières → bloom / halation →
// distorsion, aberration chromatique, vignettage → bruit capteur (ISO) et grain → tone mapping →
// sRGB → look (LUT .cube).
//
// Passes : (0) source RGBA16F ; deux pyramides de flou (6 niveaux, filtre « dual » : 5 prises à la descente,
// 8 à la montée, seuil doux au premier niveau) : une pour le bloom (seuil et étendue propres), une pour la
// halation (seuil propre, rayons larges) ; (B) composition plein cadre vers l'écran : distorsion, aberration
// chromatique, vignettage, bruit capteur, ÉMULSION (courbes par canal + couleur) ou tone mapping, LUT
// (appliquée à l'image Rec.709 affichée), grain de pellicule.
//
// Flares (étoile de diffraction, streaks anamorphiques, ghosts, lens dirt) : une pyramide de seuil propre
// (6 niveaux), une chaîne de flou HORIZONTAL seul pour le streak, puis une passe à demi-résolution qui
// compose les quatre effets en une texture de lumière ajoutée dans `comp()` avec le bloom.

import * as pc from 'playcanvas';
import { atlasWidth, lutToAtlas, type Lut3D } from '../optics/lut';
import { stockUniforms, type FilmStock } from '../optics/film-stock';
import { GHOSTS, generateDirt, starFirstAngle, starSpikeCount, streakMix } from '../optics/flare';

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
  /** Halation : halo large autour des lumières écrêtées (0 = aucune), son seuil et sa teinte (rouge-orangé). */
  halation: number;
  halationThreshold: number;
  halationTint: number[];
  /** Seuil commun des flares (étoile, streak, ghosts, dirt) : ne gardent que ce qui dépasse. */
  flareThreshold: number;
  /** Étoile de diffraction du diaphragme : part d'énergie (0 = aucune), longueur (fraction de la hauteur), pointes (0 = selon les lames). */
  starburst: number;
  starburstLength: number;
  starburstSpikes: number;
  /** Streak anamorphique horizontal : part d'énergie, longueur 0..1, teinte. */
  streak: number;
  streakLength: number;
  streakTint: number[];
  /** Ghosts (reflets internes) : intensité (0 = aucun) et nombre (1 à 6). */
  ghosts: number;
  ghostCount: number;
  /** Lens dirt : intensité (0 = aucune) ; la lumière diffusée vient des hautes lumières au-dessus du seuil des flares. */
  dirt: number;
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
  /** Intensité du look (LUT Rec.709 chargée) : 0 à 1. */
  lutAmount: number;
  /** Émulsion (id de optics/film-stock) ; '' = tone mapping seul. Voir PostProcessor.setStock. */
  stock: string;
  /** Graine du bruit (numéro d'image) : même image = même bruit, export reproductible. */
  seed: number;
}

export const DEFAULT_POST: PostParams = {
  exposureEv: 0, highlightGain: 1, toneMap: 'aces',
  bloom: 0, bloomThreshold: 1, bloomRadius: 0.6, halation: 0, halationThreshold: 1, halationTint: [1, 0.3, 0.1],
  flareThreshold: 1.5, starburst: 0, starburstLength: 0.2, starburstSpikes: 0,
  streak: 0, streakLength: 0.7, streakTint: [0.35, 0.55, 1], ghosts: 0, ghostCount: 4, dirt: 0,
  vignetteNatural: 0, vignetteOptical: 0, distortion: 0, chromaticAberration: 0,
  iso: 0, grain: 0, grainSize: 1.5, lutAmount: 1, stock: '', seed: 0,
};

const LEVELS = 6;
/** Niveaux de la pyramide des flares (1/2 à 1/64) et du streak horizontal (largeur 1/4 à 1/256). */
const FLARE_LEVELS = 6;
const STREAK_LEVELS = 7;
/** Prises par pointe de l'étoile, prises par disque de ghost. */
const STAR_TAPS = 40;
const GHOST_TAPS = 32;
export const DIRT_SIZE = 512;

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


// Streak : filtre binomial horizontal seul (descente : la largeur est divisée par 2, la hauteur reste).
const STREAK_DOWN_WGSL = /* wgsl */ `
var srcTex: texture_2d<f32>;
var srcTexSampler: sampler;
uniform uTexel: vec2f;   // taille d'un texel de la SOURCE
varying uv0: vec2f;

fn tap(uv: vec2f) -> vec3f { return textureSampleLevel(srcTex, srcTexSampler, uv, 0.0).rgb; }

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  let uv = input.uv0;
  let t = uniform.uTexel.x;
  // Le centre du texel de sortie tombe entre deux texels source : poids (1 3 3 1) / 8.
  output.color = vec4f(0.5 * tap(uv) + 0.25 * (tap(uv + vec2f(-t, 0.0)) + tap(uv + vec2f(t, 0.0))), 1.0);
  return output;
}
`;

// Montée du streak : U_k = (1 − m)·D_k + m·flouH(U_{k+1}) (somme des poids = 1, énergie conservée).
const STREAK_UP_WGSL = /* wgsl */ `
var lowTex: texture_2d<f32>;
var lowTexSampler: sampler;
var hiTex: texture_2d<f32>;
var hiTexSampler: sampler;
uniform uTexel: vec2f;   // taille d'un texel de lowTex
uniform uMix: f32;
varying uv0: vec2f;

fn tap(uv: vec2f) -> vec3f { return textureSampleLevel(lowTex, lowTexSampler, uv, 0.0).rgb; }

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  let uv = input.uv0;
  let t = uniform.uTexel.x;
  let up = 0.5 * tap(uv) + 0.25 * (tap(uv + vec2f(-t, 0.0)) + tap(uv + vec2f(t, 0.0)));
  let hi = textureSampleLevel(hiTex, hiTexSampler, uv, 0.0).rgb;
  output.color = vec4f(mix(hi, up, uniform.uMix), 1.0);
  return output;
}
`;

// Lumière des flares à demi-résolution : étoile de diffraction + streak + ghosts + lens dirt.
// Les angles de l'étoile et la forme des ghosts sont ceux de optics/flare.ts (testé) et d'aperture.ts.
const FLARE_WGSL = /* wgsl */ `
var starTex: texture_2d<f32>;      // hautes lumières au-dessus du seuil, 1/4 de résolution
var starTexSampler: sampler;
var ghostTex: texture_2d<f32>;     // idem, 1/16 (plus flou : les ghosts échantillonnent un disque, il faut lisser les prises)
var ghostTexSampler: sampler;
var scatterTex: texture_2d<f32>;   // idem, 1/64 : voile de lumière diffusée qui éclaire le dirt
var scatterTexSampler: sampler;
var streakTex: texture_2d<f32>;
var streakTexSampler: sampler;
var dirtTex: texture_2d<f32>;
var dirtTexSampler: sampler;
uniform uOut: vec4f;     // largeur, hauteur de la sortie (px), rapport du cadre, 0
uniform uStar: vec4f;    // énergie, longueur (px de sortie), nombre de pointes, angle de la première
uniform uStreak: vec4f;  // énergie, teinte RVB
uniform uGhost: vec4f;   // intensité, nombre, 0, 0
uniform uAp: vec4f;      // lames, arrondi, rotation (rad), intensité du dirt
uniform uGhA: vec4f;     // échelles des reflets 0 à 3
uniform uGhB: vec4f;     // échelles des reflets 4 et 5, 0, 0
uniform uGhR: vec4f;     // rayons des reflets 0 à 3
uniform uGhS: vec4f;     // rayons des reflets 4 et 5, 0, 0
uniform uGt0: vec4f;     // teintes des reflets 0 à 5
uniform uGt1: vec4f;
uniform uGt2: vec4f;
uniform uGt3: vec4f;
uniform uGt4: vec4f;
uniform uGt5: vec4f;
varying uv0: vec2f;

const TAU = 6.2831853;

// Miroir de bladeBoundary (optics/aperture.ts) : rayon du polygone régulier à N côtés, arrondi par 'roundness'.
fn bladeBoundary(angle: f32, n: f32, roundness: f32) -> f32 {
  if (n < 3.0) { return 1.0; }
  let wedge = TAU / n;
  let a = ((((angle - 1.5707963) % wedge) + wedge * 1.5) % wedge) - wedge * 0.5;
  let flat = cos(3.1415927 / n) / cos(wedge * 0.5 - abs(a));
  return flat + (1.0 - flat) * roundness;
}

fn pick(a: vec4f, b: vec4f, i: i32) -> f32 { if (i < 4) { return a[i]; } return b[i - 4]; }
fn tint(i: i32) -> vec3f {
  if (i == 0) { return uniform.uGt0.xyz; }
  if (i == 1) { return uniform.uGt1.xyz; }
  if (i == 2) { return uniform.uGt2.xyz; }
  if (i == 3) { return uniform.uGt3.xyz; }
  if (i == 4) { return uniform.uGt4.xyz; }
  return uniform.uGt5.xyz;
}

// Étoile : pour chaque pointe, moyenne pondérée (1 − t)² de la source le long du rayon de longueur L.
// Un point lumineux apparaît donc sur la droite qui passe par lui dans chaque direction de pointe.
fn starburst(uv: vec2f) -> vec3f {
  let n = i32(uniform.uStar.z);
  if (n < 1 || uniform.uStar.x <= 0.0) { return vec3f(0.0); }
  var acc = vec3f(0.0);
  var wsum = 0.0;
  for (var j = 1; j <= ${STAR_TAPS}; j++) { let t = f32(j) / f32(${STAR_TAPS}); wsum += (1.0 - t) * (1.0 - t); }
  for (var k = 0; k < n; k++) {
    let a = uniform.uStar.w + f32(k) * TAU / f32(n);
    let dir = vec2f(cos(a), -sin(a)) / uniform.uOut.xy;      // uv.y vers le bas
    for (var j = 1; j <= ${STAR_TAPS}; j++) {
      let t = f32(j) / f32(${STAR_TAPS});
      let w = (1.0 - t) * (1.0 - t);
      acc += w * textureSampleLevel(starTex, starTexSampler, uv + dir * (t * uniform.uStar.y), 0.0).rgb;
    }
  }
  return acc / (wsum * f32(n)) * uniform.uStar.x;
}

// Ghosts : le reflet i d'une source en p tombe en c + s_i (p − c). Pour un pixel q on lit la source en
// c + (q + R o_j − c) / s_i, o_j étant des points du polygone de l'ouverture (le reflet a la forme du diaphragme).
fn ghosts(uv: vec2f) -> vec3f {
  let count = i32(uniform.uGhost.y);
  if (count < 1 || uniform.uGhost.x <= 0.0) { return vec3f(0.0); }
  let rot = uniform.uAp.z;
  var acc = vec3f(0.0);
  for (var i = 0; i < 6; i++) {
    if (i >= count) { break; }
    let s = pick(uniform.uGhA, uniform.uGhB, i);
    let rad = pick(uniform.uGhR, uniform.uGhS, i);
    var sum = vec3f(0.0);
    for (var j = 0; j < ${GHOST_TAPS}; j++) {
      let r = sqrt((f32(j) + 0.5) / f32(${GHOST_TAPS}));
      let ang = f32(j) * 2.3999632;
      let b = bladeBoundary(ang - rot, uniform.uAp.x, uniform.uAp.y);
      let o = vec2f(cos(ang), -sin(ang)) * (r * b * rad);     // y vers le bas, en hauteur de cadre
      let q = uv + vec2f(o.x / uniform.uOut.z, o.y);
      let p = vec2f(0.5) + (q - vec2f(0.5)) / s;
      let inside = step(0.0, p.x) * step(p.x, 1.0) * step(0.0, p.y) * step(p.y, 1.0);
      sum += textureSampleLevel(ghostTex, ghostTexSampler, p, 0.0).rgb * inside;
    }
    // Les reflets s'éteignent vers les bords du cadre (là où la lentille les coupe).
    let d = length((uv - vec2f(0.5)) * vec2f(uniform.uOut.z, 1.0)) / (0.5 * sqrt(uniform.uOut.z * uniform.uOut.z + 1.0));
    acc += sum / f32(${GHOST_TAPS}) * tint(i) * (1.0 - smoothstep(0.6, 1.05, d));
  }
  return acc * uniform.uGhost.x;
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  let uv = input.uv0;
  var light = starburst(uv) + ghosts(uv);
  if (uniform.uStreak.x > 0.0) {
    light += textureSampleLevel(streakTex, streakTexSampler, uv, 0.0).rgb * uniform.uStreak.yzw * uniform.uStreak.x;
  }
  // Lens dirt : les saletés diffusent la lumière des hautes lumières (voile large) et celle des flares.
  if (uniform.uAp.w > 0.0) {
    let scatter = textureSampleLevel(scatterTex, scatterTexSampler, uv, 0.0).rgb;
    let dirt = textureSampleLevel(dirtTex, dirtTexSampler, uv, 0.0).r;
    light += dirt * uniform.uAp.w * (scatter * 4.0 + light * 0.5);
  }
  output.color = vec4f(light, 1.0);
  return output;
}
`;

// Composition. Les formules de vignettage, distorsion, bruit et tone mapping sont celles de
// optics/lens-effects.ts (testées) ; l'émulsion est celle de optics/film-stock.ts (filmLook, testée) ;
// le look est celui de optics/lut.ts (applyLut).
const COMP_WGSL = /* wgsl */ `
var srcTex: texture_2d<f32>;
var srcTexSampler: sampler;
var bloomTex: texture_2d<f32>;
var bloomTexSampler: sampler;
var halaTex: texture_2d<f32>;
var halaTexSampler: sampler;
var lutTex: texture_2d<f32>;
var lutTexSampler: sampler;
var flareTex: texture_2d<f32>;
var flareTexSampler: sampler;
uniform uF: vec4f;   // 1 = lumière des flares ajoutée
uniform uA: vec4f;   // bloom, halation, k1 (distorsion), k2
uniform uB: vec4f;   // aberration chromatique, ajustement du cadre (barillet), rapport du cadre
uniform uC: vec4f;   // vignettage naturel, optique, tan(demi-champ H), tan(demi-champ V)
uniform uD: vec4f;   // coefficient de bruit capteur, grain, taille du grain (px), graine
uniform uE: vec4f;   // tone mapping (0 aucun, 1 Reinhard, 2 ACES), intensité du look, taille de la LUT, 1 = LUT chargée
uniform uTint: vec4f;
// Émulsion (voir stockUniforms) : courbes par canal, secteurs de teinte, dominantes, monochrome.
uniform uCv0: vec4f;   // contraste R V B, pied
uniform uCv1: vec4f;   // décalage R V B (diaphragmes), épaule
uniform uCv2: vec4f;   // noir R V B, désaturation vers blanc / noir
uniform uCv3: vec4f;   // blanc R V B, saturation globale
uniform uSatA: vec4f;
uniform uSatB: vec4f;
uniform uRotA: vec4f;
uniform uRotB: vec4f;
uniform uLumA: vec4f;
uniform uLumB: vec4f;
uniform uSplitS: vec4f;   // dominante des ombres
uniform uSplitH: vec4f;   // dominante des hautes lumières, w = 1 : émulsion active
uniform uMono: vec4f;     // poids R V B, w = 1 : monochrome
varying uv0: vec2f;

const LUMA = vec3f(0.2126, 0.7152, 0.0722);

fn comp(uv: vec2f) -> vec3f {
  var o = textureSampleLevel(srcTex, srcTexSampler, uv, 0.0).rgb;
  if (uniform.uA.x > 0.0) { o += textureSampleLevel(bloomTex, bloomTexSampler, uv, 0.0).rgb * uniform.uA.x; }
  if (uniform.uA.y > 0.0) {
    // Halation : lumière revenue du support, elle ne s'ajoute que là où l'émulsion a encore de la marge.
    let headroom = 1.0 - smoothstep(0.7, 1.5, dot(o, LUMA));
    o += textureSampleLevel(halaTex, halaTexSampler, uv, 0.0).rgb * uniform.uTint.xyz * uniform.uA.y * headroom;
  }
  if (uniform.uF.x > 0.5) { o += textureSampleLevel(flareTex, flareTexSampler, uv, 0.0).rgb; }
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

// --- émulsion (miroir de filmLook, optics/film-stock.ts) ---
fn sm01(a: f32, b: f32, x: f32) -> f32 {
  let t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
fn filmCurve(x: f32, k: f32, shift: f32, black: f32, white: f32) -> f32 {
  let s = log2(max(x, 1e-6) / 0.18) + shift;
  let kk = k * mix(uniform.uCv0.w, uniform.uCv1.w, sm01(-1.5, 1.5, s));
  return black + (white - black) / (1.0 + exp(-s * kk));
}
fn rgb2hsv(c: vec3f) -> vec3f {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let d = mx - mn;
  var h = 0.0;
  if (d > 1e-9) {
    if (mx == c.r) { h = ((c.g - c.b) / d + 6.0) % 6.0; }
    else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
    else { h = (c.r - c.g) / d + 4.0; }
  }
  return vec3f(h / 6.0, select(0.0, d / mx, mx > 1e-9), mx);
}
fn hsv2rgb(c: vec3f) -> vec3f {
  let k = (vec3f(5.0, 3.0, 1.0) + c.x * 6.0) % 6.0;
  return c.z - c.z * c.y * clamp(min(k, 4.0 - k), vec3f(0.0), vec3f(1.0));
}
fn pick6(a: vec4f, b: vec4f, i: i32) -> f32 {
  if (i < 4) { return a[i]; }
  return b[i - 4];
}
fn sector(a: vec4f, b: vec4f, h: f32) -> f32 {
  let h6 = fract(h) * 6.0;
  let i = i32(floor(h6));
  let f = h6 - floor(h6);
  let t = f * f * (3.0 - 2.0 * f);
  return mix(pick6(a, b, i % 6), pick6(a, b, (i + 1) % 6), t);
}
fn filmLook(col: vec3f) -> vec3f {
  var c = vec3f(
    filmCurve(col.r, uniform.uCv0.x, uniform.uCv1.x, uniform.uCv2.x, uniform.uCv3.x),
    filmCurve(col.g, uniform.uCv0.y, uniform.uCv1.y, uniform.uCv2.y, uniform.uCv3.y),
    filmCurve(col.b, uniform.uCv0.z, uniform.uCv1.z, uniform.uCv2.z, uniform.uCv3.z));
  if (uniform.uMono.w > 0.5) { c = vec3f(dot(c, uniform.uMono.xyz)); }
  let l = dot(c, LUMA);
  let roll = uniform.uCv2.w * (sm01(0.78, 1.0, l) * 0.6 + (1.0 - sm01(0.0, 0.1, l)) * 0.4);
  c = vec3f(l) + (c - vec3f(l)) * (1.0 - roll);
  var hsv = rgb2hsv(c);
  let h = hsv.x;
  hsv.x = fract(h + sector(uniform.uRotA, uniform.uRotB, h) / 360.0 + 1.0);
  let chroma = hsv.y;
  hsv.y = clamp(hsv.y * uniform.uCv3.w * sector(uniform.uSatA, uniform.uSatB, h), 0.0, 1.0);
  hsv.z = hsv.z * (1.0 + (sector(uniform.uLumA, uniform.uLumB, h) - 1.0) * chroma);   // un gris n'a pas de teinte
  c = hsv2rgb(hsv);
  let ls = dot(c, LUMA);
  c = c + uniform.uSplitS.xyz * (1.0 - ls) * (1.0 - ls) + uniform.uSplitH.xyz * ls * ls;
  return clamp(c, vec3f(0.0), vec3f(1.0));
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

  // Bruit capteur (photons + lecture, indépendant par canal).
  let px = vec2u(uv * dims);
  let seed = u32(uniform.uD.w);
  if (uniform.uD.x > 0.0) {
    col.r += gauss(px, seed, 0u) * uniform.uD.x * sqrt(0.18 * (max(col.r, 0.0) + 0.01));
    col.g += gauss(px, seed, 1u) * uniform.uD.x * sqrt(0.18 * (max(col.g, 0.0) + 0.01));
    col.b += gauss(px, seed, 2u) * uniform.uD.x * sqrt(0.18 * (max(col.b, 0.0) + 0.01));
  }

  // Émulsion (courbes par canal + couleur) ou tone mapping, puis encodage affichage.
  var o: vec3f;
  if (uniform.uSplitH.w > 0.5) { o = filmLook(col); }               // l'émulsion produit déjà une valeur affichée
  else { o = srgbOetf(toneMap(col, uniform.uE.x)); }

  // Look (LUT 3D Rec.709) : appliqué à l'image affichée.
  if (uniform.uE.w > 0.5 && uniform.uE.y > 0.0) { o = mix(o, applyLut(o, i32(uniform.uE.z)), uniform.uE.y); }

  // Grain de pellicule : dans la densité (valeur affichée), gaussien, au plus fort dans les médiums.
  if (uniform.uD.y > 0.0) {
    let g = grainNoise(uv * dims / max(uniform.uD.z, 0.5), seed);
    let y = clamp(dot(o, LUMA), 0.0, 1.0);
    let w = clamp(4.0 * y * (1.0 - y), 0.12, 1.0);
    o = clamp(o + vec3f(g * uniform.uD.y * 0.07 * w), vec3f(0.0), vec3f(1.0));
  }
  output.color = vec4f(o, 1.0);
  return output;
}
`;

interface Target { tex: pc.Texture; rt: pc.RenderTarget }

/** Pyramide de flou : niveaux 1..LEVELS (descente) et 1..LEVELS−1 (montée). */
interface Chain { down: Target[]; up: Target[] }

/** Cibles des flares : seuil (1/2 à 1/16), streak horizontal (descente et montée), lumière composée (1/2). */
interface FlareTargets { bright: Target[]; streakDown: Target[]; streakUp: Target[]; out: Target }

export class PostProcessor {
  private readonly srcShader: pc.Shader;
  private readonly downShader: pc.Shader;
  private readonly upShader: pc.Shader;
  private readonly compShader: pc.Shader;
  private src: Target | null = null;
  private bloomChain: Chain | null = null;
  private halaChain: Chain | null = null;
  private w = 0;
  private h = 0;
  private lutTex: pc.Texture;
  private lutSize = 0;
  private stock: FilmStock | null = null;
  private readonly streakDownShader: pc.Shader;
  private readonly streakUpShader: pc.Shader;
  private readonly flareShader: pc.Shader;
  private flare: FlareTargets | null = null;
  private dirtTex: pc.Texture;
  private dirtBytes: Uint8Array | null = null;
  private dirtSize = DIRT_SIZE;
  /** Forme du diaphragme (lames, arrondi, rotation °) : pointes de l'étoile et forme des ghosts. */
  private aperture = { blades: 0, roundness: 1, rotationDeg: 0 };

  constructor(private readonly device: pc.GraphicsDevice) {
    const mk = (name: string, fragmentWGSL: string) => pc.ShaderUtils.createShader(device, {
      uniqueName: name, attributes: { aPosition: pc.SEMANTIC_POSITION }, vertexChunk: 'quadVS', fragmentWGSL,
    });
    this.srcShader = mk('SplatCamPostSrc', SRC_WGSL);
    this.downShader = mk('SplatCamPostDown', DOWN_WGSL);
    this.upShader = mk('SplatCamPostUp', UP_WGSL);
    this.compShader = mk('SplatCamPostComp', COMP_WGSL);
    this.streakDownShader = mk('SplatCamStreakDown', STREAK_DOWN_WGSL);
    this.streakUpShader = mk('SplatCamStreakUp', STREAK_UP_WGSL);
    this.flareShader = mk('SplatCamFlare', FLARE_WGSL);
    this.dirtTex = this.makeDirtTexture(new Uint8Array(4), 1);
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

  /** Émulsion active (courbes par canal et couleur) ; null = tone mapping seul. */
  setStock(stock: FilmStock | null): void { this.stock = stock; }

  /** Forme du diaphragme de l'objectif courant (étoile et ghosts). */
  setAperture(blades: number, roundness: number, rotationDeg: number): void { this.aperture = { blades, roundness, rotationDeg }; }

  private makeDirtTexture(rgba: Uint8Array, size: number): pc.Texture {
    return new pc.Texture(this.device, {
      name: 'splatcam-dirt', width: size, height: size, format: pc.PIXELFORMAT_RGBA8, mipmaps: false,
      minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
      levels: [rgba],
    });
  }

  /** Masque de saleté (un octet par texel, `size`×`size`, 255 = opaque) ; null = masque procédural par défaut. */
  setDirt(bytes: Uint8Array | null, size = DIRT_SIZE): void {
    this.dirtBytes = bytes;
    this.dirtSize = size;
    this.dirtTex.destroy();
    this.dirtTex = this.makeDirtTexture(new Uint8Array(4), 1);   // recréée au prochain usage (voir run)
    this.dirtReady = false;
  }
  private dirtReady = false;

  private ensureDirt(): void {
    if (this.dirtReady) return;
    const bytes = this.dirtBytes ?? generateDirt(DIRT_SIZE, 1);
    const size = this.dirtBytes ? this.dirtSize : DIRT_SIZE;
    const rgba = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) { rgba[4 * i] = rgba[4 * i + 1] = rgba[4 * i + 2] = bytes[i]; rgba[4 * i + 3] = 255; }
    this.dirtTex.destroy();
    this.dirtTex = this.makeDirtTexture(rgba, size);
    this.dirtReady = true;
  }

  private makeTarget(w: number, h: number, name: string): Target {
    const tex = new pc.Texture(this.device, {
      name, width: w, height: h, format: pc.PIXELFORMAT_RGBA16F, mipmaps: false,
      minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    return { tex, rt: new pc.RenderTarget({ colorBuffer: tex, depth: false, name }) };
  }

  private makeChain(w: number, h: number, name: string): Chain {
    const down: Target[] = [], up: Target[] = [];
    for (let k = 1; k <= LEVELS; k++) down.push(this.makeTarget(Math.max(1, w >> k), Math.max(1, h >> k), `${name}-down-${k}`));
    for (let k = 1; k < LEVELS; k++) up.push(this.makeTarget(Math.max(1, w >> k), Math.max(1, h >> k), `${name}-up-${k}`));
    return { down, up };
  }

  private freeAll(ts: Target[]): void { for (const t of ts) { t.rt.destroy(); t.tex.destroy(); } }

  private ensure(w: number, h: number): void {
    if (w === this.w && h === this.h && this.src) return;
    this.freeAll(this.src ? [this.src] : []);
    for (const c of [this.bloomChain, this.halaChain]) if (c) { this.freeAll(c.down); this.freeAll(c.up); }
    this.freeFlare();
    this.src = this.makeTarget(w, h, 'splatcam-post-src');
    this.bloomChain = this.makeChain(w, h, 'splatcam-bloom');
    this.halaChain = this.makeChain(w, h, 'splatcam-hala');
    this.w = w; this.h = h;
  }

  /** Descente « dual » de `src` à travers `downs`, seuil doux au premier niveau. */
  private downsample(downs: Target[], src: Target, threshold: number): void {
    const { scope } = this.device;
    for (let k = 0; k < downs.length; k++) {
      const from = k === 0 ? src : downs[k - 1];
      scope.resolve('srcTex').setValue(from.tex);
      scope.resolve('uTexel').setValue([1 / from.tex.width, 1 / from.tex.height]);
      scope.resolve('uPre').setValue([threshold, 0.5 * threshold, k === 0 ? 1 : 0, 0]);
      pc.drawQuadWithShader(this.device, downs[k].rt, this.downShader);
    }
  }

  private freeFlare(): void {
    if (!this.flare) return;
    this.freeAll(this.flare.bright); this.freeAll(this.flare.streakDown); this.freeAll(this.flare.streakUp); this.freeAll([this.flare.out]);
    this.flare = null;
  }

  private ensureFlare(): FlareTargets {
    if (this.flare) return this.flare;
    const { w, h } = this;
    const bright: Target[] = [], streakDown: Target[] = [], streakUp: Target[] = [];
    for (let k = 1; k <= FLARE_LEVELS; k++) bright.push(this.makeTarget(Math.max(1, w >> k), Math.max(1, h >> k), `splatcam-flare-${k}`));
    for (let k = 0; k < STREAK_LEVELS; k++) {
      const t = (n: string) => this.makeTarget(Math.max(1, w >> (k + 2)), Math.max(1, h >> 1), `splatcam-streak-${n}-${k}`);
      streakDown.push(t('down'));
      if (k < STREAK_LEVELS - 1) streakUp.push(t('up'));
    }
    this.flare = { bright, streakDown, streakUp, out: this.makeTarget(Math.max(1, w >> 1), Math.max(1, h >> 1), 'splatcam-flare-out') };
    return this.flare;
  }

  /**
   * Lumière des flares (étoile, streak, ghosts, dirt) à demi-résolution. Renvoie sa texture, ou null si rien n'est actif.
   * Le streak est un flou horizontal seul sur la pyramide du seuil : montée U_k = (1 − m)·D_k + m·flou(U_{k+1}).
   */
  private flarePass(src: Target, p: PostParams, aspect: number): pc.Texture | null {
    if (p.starburst <= 0 && p.streak <= 0 && p.ghosts <= 0 && p.dirt <= 0) return null;
    const { scope } = this.device;
    const f = this.ensureFlare();
    this.downsample(f.bright, src, p.flareThreshold);

    if (p.streak > 0) {
      for (let k = 0; k < STREAK_LEVELS; k++) {
        const from = k === 0 ? f.bright[0] : f.streakDown[k - 1];
        scope.resolve('srcTex').setValue(from.tex);
        scope.resolve('uTexel').setValue([1 / from.tex.width, 1 / from.tex.height]);
        pc.drawQuadWithShader(this.device, f.streakDown[k].rt, this.streakDownShader);
      }
      const m = streakMix(p.streakLength);
      for (let k = STREAK_LEVELS - 2; k >= 0; k--) {
        const low = k === STREAK_LEVELS - 2 ? f.streakDown[STREAK_LEVELS - 1] : f.streakUp[k + 1];
        scope.resolve('lowTex').setValue(low.tex);
        scope.resolve('hiTex').setValue(f.streakDown[k].tex);
        scope.resolve('uTexel').setValue([1 / low.tex.width, 1 / low.tex.height]);
        scope.resolve('uMix').setValue(m);
        pc.drawQuadWithShader(this.device, f.streakUp[k].rt, this.streakUpShader);
      }
    }
    if (p.dirt > 0) this.ensureDirt();

    const out = f.out;
    const ap = this.aperture;
    const spikes = p.starburst > 0 ? starSpikeCount(ap.blades, p.starburstSpikes) : 0;
    scope.resolve('starTex').setValue(f.bright[1].tex);
    scope.resolve('ghostTex').setValue(f.bright[3].tex);
    scope.resolve('scatterTex').setValue(f.bright[5].tex);
    scope.resolve('streakTex').setValue(p.streak > 0 ? f.streakUp[0].tex : f.bright[0].tex);
    scope.resolve('dirtTex').setValue(this.dirtTex);
    scope.resolve('uOut').setValue([out.tex.width, out.tex.height, aspect, 0]);
    // Longueur de pointe en pixels de la sortie (fraction de la hauteur du cadre).
    scope.resolve('uStar').setValue([p.starburst, p.starburstLength * out.tex.height, spikes, starFirstAngle(ap.blades, ap.rotationDeg)]);
    scope.resolve('uStreak').setValue([p.streak, p.streakTint[0], p.streakTint[1], p.streakTint[2]]);
    scope.resolve('uGhost').setValue([p.ghosts, Math.min(Math.max(Math.round(p.ghostCount), 1), GHOSTS.length), 0, 0]);
    scope.resolve('uAp').setValue([ap.blades, ap.roundness, (ap.rotationDeg * Math.PI) / 180, p.dirt]);
    const g = GHOSTS;
    scope.resolve('uGhA').setValue([g[0].scale, g[1].scale, g[2].scale, g[3].scale]);
    scope.resolve('uGhB').setValue([g[4].scale, g[5].scale, 0, 0]);
    scope.resolve('uGhR').setValue([g[0].radius, g[1].radius, g[2].radius, g[3].radius]);
    scope.resolve('uGhS').setValue([g[4].radius, g[5].radius, 0, 0]);
    for (let i = 0; i < 6; i++) scope.resolve(`uGt${i}`).setValue([g[i].tint[0], g[i].tint[1], g[i].tint[2], 0]);
    pc.drawQuadWithShader(this.device, out.rt, this.flareShader);
    return out.tex;
  }

  /**
   * Pyramide de flou de `src` : descente avec seuil doux au premier niveau, puis montée
   * U_k = (1 − m)·D_k + m·flou(U_{k+1}) (U_LEVELS = D_LEVELS). Renvoie la montée.
   */
  private blur(chain: Chain, src: Target, threshold: number, mix: number): Target[] {
    const { scope } = this.device;
    const draw = (rt: pc.RenderTarget, shader: pc.Shader) => pc.drawQuadWithShader(this.device, rt, shader);
    this.downsample(chain.down, src, threshold);
    for (let k = LEVELS - 1; k >= 1; k--) {
      const low = k === LEVELS - 1 ? chain.down[LEVELS - 1] : chain.up[k];
      scope.resolve('lowTex').setValue(low.tex);
      scope.resolve('hiTex').setValue(chain.down[k - 1].tex);
      scope.resolve('uTexel').setValue([1 / low.tex.width, 1 / low.tex.height]);
      scope.resolve('uMix').setValue(mix);
      draw(chain.up[k - 1].rt, this.upShader);
    }
    return chain.up;
  }

  /**
   * Applique la chaîne à l'accumulateur et affiche dans `rect` (pixels écran).
   * `exposure` : facteur de normalisation des échantillons ; `aspect` et `tanV` : cadre et demi-champ vertical (tan).
   */
  run(accum: pc.Texture, w: number, h: number, exposure: number, aspect: number, tanV: number, p: PostParams, rect: pc.Vec4): void {
    this.ensure(w, h);
    const { scope } = this.device;
    const src = this.src!;

    scope.resolve('accumTex').setValue(accum);
    scope.resolve('uExp').setValue([exposure * Math.pow(2, p.exposureEv), p.highlightGain, 0, 0]);
    pc.drawQuadWithShader(this.device, src.rt, this.srcShader);

    const bloomUp = p.bloom > 0 ? this.blur(this.bloomChain!, src, p.bloomThreshold, p.bloomRadius) : null;
    const halaUp = p.halation > 0 ? this.blur(this.halaChain!, src, p.halationThreshold, 0.75) : null;

    const flareTex = this.flarePass(src, p, aspect);

    const dist = p.distortion;
    scope.resolve('srcTex').setValue(src.tex);
    scope.resolve('flareTex').setValue(flareTex ?? src.tex);
    scope.resolve('uF').setValue([flareTex ? 1 : 0, 0, 0, 0]);
    scope.resolve('bloomTex').setValue(bloomUp ? bloomUp[0].tex : src.tex);   // U1 : tous les rayons
    scope.resolve('halaTex').setValue(halaUp ? halaUp[2].tex : src.tex);      // U3 : rayons larges
    scope.resolve('lutTex').setValue(this.lutTex);
    scope.resolve('uA').setValue([p.bloom, p.halation, dist, 0]);
    scope.resolve('uB').setValue([p.chromaticAberration * 0.006, Math.max(1, 1 + dist), aspect, 0]);
    scope.resolve('uC').setValue([p.vignetteNatural, p.vignetteOptical, tanV * aspect, tanV]);
    const iso = p.iso > 0 ? 0.03 * Math.sqrt(p.iso / 800) : 0;
    scope.resolve('uD').setValue([iso, p.grain, p.grainSize, p.seed]);
    scope.resolve('uE').setValue([TONE_ID[p.toneMap], p.lutAmount, this.lutSize, this.lutSize > 0 ? 1 : 0]);
    scope.resolve('uTint').setValue([p.halationTint[0], p.halationTint[1], p.halationTint[2], 0]);

    const st = stockUniforms(this.stock);
    scope.resolve('uCv0').setValue(st.cv0); scope.resolve('uCv1').setValue(st.cv1);
    scope.resolve('uCv2').setValue(st.cv2); scope.resolve('uCv3').setValue(st.cv3);
    scope.resolve('uSatA').setValue(st.satA); scope.resolve('uSatB').setValue(st.satB);
    scope.resolve('uRotA').setValue(st.rotA); scope.resolve('uRotB').setValue(st.rotB);
    scope.resolve('uLumA').setValue(st.lumA); scope.resolve('uLumB').setValue(st.lumB);
    scope.resolve('uSplitS').setValue(st.splitS); scope.resolve('uSplitH').setValue(st.splitH);
    scope.resolve('uMono').setValue(st.mono);

    pc.drawQuadWithShader(this.device, null, this.compShader, rect);
  }
}
