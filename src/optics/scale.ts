// Échelle de scène : un splat est exprimé en unités arbitraires, la caméra
// et l'optique raisonnent en mètres. `metersPerUnit` fait le pont.

export function unitsToMeters(units: number, metersPerUnit: number): number {
  return units * metersPerUnit;
}

export function metersToUnits(meters: number, metersPerUnit: number): number {
  return meters / metersPerUnit;
}
