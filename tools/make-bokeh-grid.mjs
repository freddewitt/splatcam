// Génère samples/bokeh-grid.ply : grille de points lumineux à 6 m pour juger la forme du bokeh (M3).
// Caméra à l'origine regardant -Z, 1 unité = 1 m. Réglage de référence : Full Frame 36 mm, 50 mm f/1.4,
// map 1 m (disques ≈ 48 px sur un cadre de 1104 px), échelle 1 m/unité.
// Usage : node tools/make-bokeh-grid.mjs
import { writeFileSync } from 'node:fs';

const COLS = 9, ROWS = 5, Z = 6;
const TAN_H = 18 / 50, TAN_V = 12 / 50;       // demi-champ FF 50 mm
const C0 = 0.28209479177387814;
const LUMI = 13;                              // HDR : empreinte σ = 2,5 px (énergie ≈ 12× celle de make-mire.mjs), plateau du disque ≈ 1
const fdc = (Math.pow(LUMI, 1 / 2.2) - 0.5) / C0;
const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const n = COLS * ROWS;
const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
const buf = Buffer.alloc(n * props.length * 4);
const sc = Math.log((2.5 * Z * TAN_H) / 552); // empreinte écran de 2,5 px (adoucit les grains du disque)
let i = 0;
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
  const nx = (c / (COLS - 1)) * 1.8 - 0.9, ny = (r / (ROWS - 1)) * 1.8 - 0.9; // NDC, marge pour les disques
  const v = [nx * Z * TAN_H, ny * Z * TAN_V, -Z, fdc, fdc, fdc, 12, sc, sc, sc, 1, 0, 0, 0];
  v.forEach((x, j) => buf.writeFloatLE(x, (i * props.length + j) * 4));
  i++;
}
writeFileSync('samples/bokeh-grid.ply', Buffer.concat([Buffer.from(header), buf]));
console.log(`samples/bokeh-grid.ply : ${n} points`);
