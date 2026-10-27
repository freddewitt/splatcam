// Génère samples/ramp.ply : deux rangées de plaques de couleur unie à radiance linéaire connue (M6, émulsions).
// Caméra à l'origine regardant −Z, plaques à Z = −4. Réglage de référence : Full Frame, 50 mm, f/16, map 4 m,
// échelle 1 m/unité, exposition d'affichage 1. Rangée du haut : 21 gris de −6 à +4 diaphragmes autour de 0,18
// (0,0028 à 2,9). Rangée du bas : 14 couleurs (primaires, secondaires, peau, feuillage, ciel, gris moyen).
// Radiance (linéaire) = (0,5 + C0·f_dc)^2,2 (décodage gamma du shader gsplat), voir tools/make-bokeh-grid.mjs.
// Usage : node tools/make-ramp.mjs
import { writeFileSync } from 'node:fs';

const Z = 4, C0 = 0.28209479177387814, GAMMA = 2.2;
const enc = (lin) => (Math.pow(Math.max(lin, 1e-6), 1 / GAMMA) - 0.5) / C0;

const grays = Array.from({ length: 21 }, (_, i) => { const v = 0.18 * Math.pow(2, -6 + i * 0.5); return [v, v, v]; });
const colors = [
  [0.45, 0.04, 0.03], [0.5, 0.18, 0.03], [0.5, 0.45, 0.04], [0.06, 0.4, 0.05], [0.04, 0.4, 0.4], [0.04, 0.06, 0.45], [0.4, 0.05, 0.4],
  [0.36, 0.21, 0.15], [0.62, 0.42, 0.33], [0.1, 0.22, 0.06], [0.2, 0.3, 0.55], [0.18, 0.18, 0.18], [0.6, 0.6, 0.6], [0.03, 0.03, 0.03],
];
const rows = [{ y: 0.55, patches: grays, step: 0.125 }, { y: 0.12, patches: colors, step: 0.185 }];
const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const splats = [];
const sc = Math.log(0.02), N = 6; // grille 6×6 de splats σ = 2 cm par plaque de 12 cm : plateau uniforme
for (const row of rows) {
  const n = row.patches.length;
  row.patches.forEach((rgb, i) => {
    const cx = (i - (n - 1) / 2) * row.step, size = row.step * 0.78;
    for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
      const x = cx + ((a / (N - 1)) - 0.5) * size, y = row.y + ((b / (N - 1)) - 0.5) * size;
      splats.push([x, y, -Z, enc(rgb[0]), enc(rgb[1]), enc(rgb[2]), 12, sc, sc, sc, 1, 0, 0, 0]);
    }
  });
}
const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${splats.length}\n${props.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
const buf = Buffer.alloc(splats.length * props.length * 4);
splats.forEach((v, i) => v.forEach((x, j) => buf.writeFloatLE(x, (i * props.length + j) * 4)));
writeFileSync('samples/ramp.ply', Buffer.concat([Buffer.from(header), buf]));
writeFileSync('samples/ramp.json', JSON.stringify({ Z, rows: rows.map((r) => ({ y: r.y, step: r.step, patches: r.patches })) }));
console.log(`samples/ramp.ply : ${splats.length} splats, ${grays.length + colors.length} plaques`);
