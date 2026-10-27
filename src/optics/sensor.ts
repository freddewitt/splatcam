// Formats de capteur / de film et formules de champ de vision.
// Dimensions en millimètres (zone image active, valeurs usuelles : à ajuster
// selon le mode d'enregistrement exact d'une caméra réelle).

export interface SensorFormat {
  id: string;
  label: string;
  /** Largeur de la zone image, mm. */
  width: number;
  /** Hauteur de la zone image, mm. */
  height: number;
}

export const SENSOR_FORMATS: readonly SensorFormat[] = [
  { id: 'super8', label: 'Super 8', width: 5.79, height: 4.01 },
  { id: 'super16', label: 'Super 16', width: 12.52, height: 7.41 },
  { id: 'm43', label: 'Micro 4/3', width: 17.3, height: 13.0 },
  { id: 'aps-c', label: 'APS-C', width: 23.5, height: 15.6 },
  { id: 's35-16x9', label: 'Super 35 (16:9, numérique)', width: 23.76, height: 13.37 },
  { id: 's35-4perf', label: 'Super 35 (4 perfs, 1,33)', width: 24.89, height: 18.66 },
  { id: 'ff', label: 'Full Frame 24×36', width: 36, height: 24 },
  { id: 'lf', label: 'Large Format (ARRI 65)', width: 54.12, height: 25.58 },
  { id: 'mf', label: 'Moyen format 44×33', width: 43.8, height: 32.9 },
];

export const DEFAULT_SENSOR_ID = 's35-16x9';

export function getSensor(id: string): SensorFormat {
  return SENSOR_FORMATS.find((s) => s.id === id) ?? SENSOR_FORMATS.find((s) => s.id === DEFAULT_SENSOR_ID)!;
}

/** Angle de champ (radians) d'une dimension de capteur `size` (mm) pour la focale `focal` (mm) : 2·atan(size / 2f). */
export function fovFromFocal(size: number, focal: number): number {
  return 2 * Math.atan(size / (2 * focal));
}

/** Focale (mm) donnant l'angle `fov` (radians) sur une dimension `size` (mm) : f = size / (2·tan(fov/2)). */
export function focalFromFov(size: number, fov: number): number {
  return size / (2 * Math.tan(fov / 2));
}

export interface Fov {
  /** Radians. */
  h: number;
  v: number;
  d: number;
}

/** Champs horizontal, vertical et diagonal (radians) d'un capteur avec une focale. */
export function sensorFov(sensor: Pick<SensorFormat, 'width' | 'height'>, focal: number): Fov {
  const diag = Math.hypot(sensor.width, sensor.height);
  return {
    h: fovFromFocal(sensor.width, focal),
    v: fovFromFocal(sensor.height, focal),
    d: fovFromFocal(diag, focal),
  };
}

export const rad2deg = (r: number): number => (r * 180) / Math.PI;
export const deg2rad = (d: number): number => (d * Math.PI) / 180;
