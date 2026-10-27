// Mise au point par clic : lancer de rayon sur les centres de splats pondérés par l'opacité.
// Les splats n'écrivent pas de profondeur : on simule la composition alpha le long du rayon et on
// retient la profondeur à laquelle l'opacité cumulée dépasse 50 %.

export interface PickData {
  /** Centres xyz entrelacés. */
  centers: Float32Array;
  /** Opacité 0..1 par splat (null : 1 partout). */
  opacity?: Float32Array | null;
  /** Écart-type (unités de scène) par splat (null : seule la tolérance angulaire compte). */
  sigma?: Float32Array | null;
}

type V3 = readonly [number, number, number];

/**
 * @param origin   position de la caméra (unités de scène)
 * @param forward  axe optique (unitaire) : la profondeur retournée est mesurée dessus (distance de map)
 * @param dir      direction du rayon du clic (unitaire)
 * @param tolAngle tolérance angulaire du rayon (rad) : ≈ 3 px d'angle
 * @returns profondeur sur l'axe optique (unités de scène), ou null si le rayon ne touche rien
 */
export function pickDepth(data: PickData, origin: V3, forward: V3, dir: V3, tolAngle: number): number | null {
  const { centers, opacity, sigma } = data;
  const n = centers.length / 3;
  const hits: { depth: number; a: number }[] = [];
  for (let i = 0; i < n; i++) {
    const dx = centers[i * 3] - origin[0], dy = centers[i * 3 + 1] - origin[1], dz = centers[i * 3 + 2] - origin[2];
    const t = dx * dir[0] + dy * dir[1] + dz * dir[2];
    if (t <= 0) continue;
    const px = dx - t * dir[0], py = dy - t * dir[1], pz = dz - t * dir[2];
    const perp2 = px * px + py * py + pz * pz;
    const s = Math.max(sigma ? sigma[i] : 0, tolAngle * t * 0.5);
    if (perp2 > 6.25 * s * s) continue; // au-delà de 2,5 σ
    const a = (opacity ? opacity[i] : 1) * Math.exp(-0.5 * perp2 / (s * s));
    if (a < 0.02) continue;
    hits.push({ depth: dx * forward[0] + dy * forward[1] + dz * forward[2], a });
  }
  if (!hits.length) return null;
  hits.sort((p, q) => p.depth - q.depth);
  let transmittance = 1;
  for (const h of hits) {
    transmittance *= 1 - Math.min(h.a, 0.999);
    if (transmittance < 0.5) return h.depth;
  }
  // Opacité cumulée < 50 % : on retient le splat le plus contributif.
  return hits.reduce((best, h) => (h.a > best.a ? h : best)).depth;
}
