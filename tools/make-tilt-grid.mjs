// Génère samples/tilt-grid.ply : grille de points lumineux posés SUR le plan de netteté d'un tilt de 3° (M3).
// Caméra à l'origine regardant -Z, 1 unité = 1 m. Réglage de référence : Full Frame 36 mm, 50 mm f/1.4,
// mise au point 2 m, tilt +3° (plan plus proche en bas : de 1,4 m en bas à 3,6 m en haut). Avec le tilt tous
// les points sont nets ; sans tilt (plan perpendiculaire à 2 m) ils sont flous d'autant plus qu'ils s'en écartent.
// Usage : node tools/make-tilt-grid.mjs
import { writeFileSync } from 'node:fs';

const COLS = 9, ROWS = 5, D = 2, F = 0.05, TILT = 3;
const TAN_H = 18 / 50, TAN_V = 12 / 50;       // demi-champ FF 50 mm
const tauY = -Math.sin((TILT * Math.PI) / 180) / F;
const C0 = 0.28209479177387814;
const LUMI = 13;
const fdc = (Math.pow(LUMI, 1 / 2.2) - 0.5) / C0;
const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const n = COLS * ROWS;
const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
const buf = Buffer.alloc(n * props.length * 4);
let i = 0;
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
  const nx = (c / (COLS - 1)) * 1.8 - 0.9, ny = (r / (ROWS - 1)) * 1.8 - 0.9; // NDC
  const vx = nx * TAN_H, vy = ny * TAN_V;
  const s = D / (1 + D * tauY * vy);                                        // profondeur du plan incliné sur ce rayon
  const sc = Math.log((2.5 * s * TAN_H) / 552);                             // empreinte écran de 2,5 px
  const v = [vx * s, vy * s, -s, fdc, fdc, fdc, 12, sc, sc, sc, 1, 0, 0, 0];
  v.forEach((x, j) => buf.writeFloatLE(x, (i * props.length + j) * 4));
  i++;
}
writeFileSync('samples/tilt-grid.ply', Buffer.concat([Buffer.from(header), buf]));
console.log(`samples/tilt-grid.ply : ${n} points`);
