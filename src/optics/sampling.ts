// Suite de Halton (bases 2 et 3), brique de l'échantillonnage d'ouverture (voir aperture.ts).
// Déterministe : l'échantillon i est toujours le même (export reproductible).

/** Suite de Halton (inverse radical) de l'indice `i` ≥ 1 dans la base `base`, dans [0, 1). */
export function halton(i: number, base: number): number {
  let f = 1, r = 0;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}
