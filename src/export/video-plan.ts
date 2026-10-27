// Export vidéo : parties pures (quantification 8 bits, débit par défaut, commandes ffmpeg de finition).

/** Flottants RGBA [0, 1] (ligne 0 = haut) → octets RGBA, arrondis et écrêtés. Alpha forcé à 255. */
export function rgbaToBytes(px: Float32Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = px[4 * i + c];
      out[4 * i + c] = v <= 0 || Number.isNaN(v) ? 0 : v >= 1 ? 255 : Math.round(v * 255);
    }
    out[4 * i + 3] = 255;
  }
  return out;
}

/** Débit H.264 / H.265 conseillé (Mbit/s) pour un aperçu : ≈ 0,25 bit par pixel et par image, arrondi à 0,5. */
export function defaultBitrateMbps(w: number, h: number, fps: number): number {
  return Math.max(1, Math.round((w * h * fps * 0.25) / 1e6 * 2) / 2);
}

export interface FfmpegOptions {
  fps: number;
  /** Préfixe des images : `shot` pour `shot_00001.png`. */
  prefix?: string;
}

export interface FfmpegCommand { label: string; file: string; command: string }

/**
 * Commandes de finition depuis la séquence PNG 16 bits (à lancer dans le dossier des images).
 * Les PNG sont encodés sRGB par la chaîne de post : conversion RGB → YUV avec la matrice BT.709, plage « tv »,
 * balises couleur posées pour que les lecteurs interprètent comme l'aperçu.
 */
/** Cadence au format ffmpeg : les cadences NTSC (23,976 / 29,97 / 59,94) en fraction exacte n·1000/1001. */
export function ffmpegRate(fps: number): string {
  for (const n of [24, 30, 48, 60]) if (Math.abs(fps - (n * 1000) / 1001) < 0.002) return `${n * 1000}/1001`;
  return String(fps);
}

export function ffmpegCommands({ fps, prefix = 'shot' }: FfmpegOptions): FfmpegCommand[] {
  const input = `ffmpeg -framerate ${ffmpegRate(fps)} -start_number 1 -i ${prefix}_%05d.png`;
  const tags = '-color_primaries bt709 -color_trc iec61966-2-1 -colorspace bt709';
  const scale = (fmt: string) => `-vf "scale=out_color_matrix=bt709:out_range=tv,format=${fmt}"`;
  return [
    {
      label: 'ProRes 4444 (10 bits, montage et étalonnage)',
      file: `${prefix}_prores4444.mov`,
      command: `${input} ${scale('yuv444p10le')} -c:v prores_ks -profile:v 4 -vendor apl0 ${tags} ${prefix}_prores4444.mov`,
    },
    {
      label: 'H.265 10 bits (livraison légère)',
      file: `${prefix}_h265_10bit.mp4`,
      command: `${input} ${scale('yuv420p10le')} -c:v libx265 -preset slow -crf 14 -tag:v hvc1 ${tags} ${prefix}_h265_10bit.mp4`,
    },
  ];
}
