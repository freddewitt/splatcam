// Profondeur de champ : lentille mince, cercle de confusion (CoC), hyperfocale,
// et cisaillement de projection utilisé par l'accumulation d'échantillons d'ouverture.
// Toutes les longueurs de ce fichier sont dans UNE même unité (mm en pratique) :
// l'appelant convertit (mètres → mm, unités de scène → mètres via `scale.ts`).

/** Diamètre de la pupille d'entrée : A = f / N. */
export function apertureDiameter(focal: number, fNumber: number): number {
  return focal / fNumber;
}

/**
 * Diamètre du cercle de confusion SUR LE CAPTEUR pour un point à la distance `z` de l'objectif,
 * l'objectif étant mis au point à `focus` (lentille mince) :
 *   c = A · f · |z − d| / ( z · (d − f) )     avec A = f / N
 * `focus` doit être > focale.
 */
export function cocDiameter(focal: number, fNumber: number, focus: number, z: number): number {
  const A = apertureDiameter(focal, fNumber);
  return (A * focal * Math.abs(z - focus)) / (z * (focus - focal));
}

/**
 * Facteur appliqué au rayon d'ouverture dans le modèle « sténopé + cisaillement » pour retrouver
 * la CoC exacte de la lentille mince tout en gardant le champ de vision donné par la focale f.
 * Le capteur est à v = f·d/(d−f) de la lentille (tirage) ; le modèle sténopé utilise f, d'où
 * le facteur v/f = d/(d−f).
 */
export function apertureScale(focal: number, focus: number): number {
  return focus / (focus - focal);
}

/** Distance hyperfocale : H = f²/(N·c) + f, `coc` = cercle de confusion admissible sur le capteur. */
export function hyperfocal(focal: number, fNumber: number, coc: number): number {
  return (focal * focal) / (fNumber * coc) + focal;
}

/** Limites de netteté (proche, lointaine) autour de `focus` ; lointaine = Infinity au-delà de l'hyperfocale. */
export function dofLimits(focal: number, fNumber: number, coc: number, focus: number): { near: number; far: number } {
  const H = hyperfocal(focal, fNumber, coc);
  const near = (focus * (H - focal)) / (H + focus - 2 * focal);
  const far = focus >= H ? Infinity : (focus * (H - focal)) / (H - focus);
  return { near, far };
}

/**
 * Terme de cisaillement à ajouter à l'élément (ligne x ou y, colonne z) de la matrice de projection
 * pour qu'une caméra décalée de `offset` dans le plan de l'objectif voie les points du plan de
 * netteté (distance `focus`) au même endroit que la caméra centrale.
 *   ndc' = p·(x − o)/(−z) − P02  ;  sur le plan z = −d : ndc' = ndc  ⇔  P02 = −p·o/d
 * `p` = élément diagonal de la projection (P00 pour x, P11 pour y).
 */
export function shearTerm(offset: number, p: number, focus: number): number {
  return (-offset * p) / focus;
}

/** Coordonnée NDC (x ou y) d'un point par la caméra décalée cisaillée. `coord`, `z` : repère de la caméra centrale (z < 0 devant). */
export function ndcWithShear(coord: number, z: number, offset: number, p: number, focus: number): number {
  return (p * (coord - offset)) / -z - shearTerm(offset, p, focus);
}
