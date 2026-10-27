// Génère samples/mire.ply : points lumineux à profondeurs connues pour valider la CoC (M2).
// Caméra à l'origine regardant -Z. Unités : 1 unité = 1 m (échelle 1).
// Usage : node tools/make-mire.mjs
import { writeFileSync } from 'node:fs';

const TAN_H = 18 / 50; // demi-largeur de capteur FF (18 mm) / focale 50 mm
// Réglage de référence de la mesure : Full Frame 36 mm, 50 mm f/1.4, map 2 m, cadre ≈ 1104 px de large.
// [profondeur m, position horizontale NDC]. Deux points sur le plan de netteté (2 m) : doivent rester nets.
const points = [[1, -0.8], [1.5, -0.45], [2, -0.6], [2, 0.6], [3, 0.0], [6, 0.8]];

// Chaque point est d'autant plus lumineux (HDR, > 1) que son disque de flou attendu est grand, pour que le
// plateau du disque reste ≈ constant et non saturé à l'affichage (mesure : tools/measure-mire.py).
const F = 50, N = 1.4, D = 2, SENSOR_W = 36, FRAME_PX = 1104;
const cocPx = (z) => ((F / N) * F * Math.abs(z - D) * 1000) / (z * 1000 * (D * 1000 - F)) * (FRAME_PX / SENSOR_W);
const E0 = 3.5; // énergie ≈ d'un point en px² pour une empreinte de 0,5 px (σ² ≈ 0,25 + 0,3 de dilatation moteur)
const lumi = (z) => (z === D ? 1 : (0.3 * Math.PI / 4 * cocPx(z) ** 2) / E0);

const C0 = 0.28209479177387814;
const fdcOf = (linear) => (Math.pow(linear, 1 / 2.2) - 0.5) / C0;
const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${points.length}\n${props.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
const buf = Buffer.alloc(points.length * props.length * 4);
points.forEach(([d, ndc], i) => {
  const fdc = fdcOf(lumi(d));
  // Empreinte écran constante (σ = 0,5 px) à toute profondeur : σ_monde = 0,5 px · z · tanH / (demi-cadre 552 px).
  const sc = Math.log((0.5 * d * TAN_H) / (FRAME_PX / 2));
  const v = [ndc * d * TAN_H, 0, -d, fdc, fdc, fdc, 12, sc, sc, sc, 1, 0, 0, 0];
  v.forEach((x, j) => buf.writeFloatLE(x, (i * props.length + j) * 4));
});
writeFileSync('samples/mire.ply', Buffer.concat([Buffer.from(header), buf]));
console.log(`samples/mire.ply : ${points.length} points`);
