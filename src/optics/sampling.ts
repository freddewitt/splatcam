// Tirage d'échantillons d'ouverture : suite de Halton (bases 2 et 3) projetée sur le disque unité.
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

/** Échantillon `i` (≥ 0) uniformément réparti en AIRE sur le disque unité : [x, y]. */
export function diskSample(i: number): [number, number] {
  const u = halton(i + 1, 2), v = halton(i + 1, 3);
  const r = Math.sqrt(u), a = 2 * Math.PI * v;
  return [r * Math.cos(a), r * Math.sin(a)];
}
