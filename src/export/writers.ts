// Ce que l'export produit pour chaque image : un PNG 16 bits dans une destination, ou une image de l'aperçu MP4.

import { encodePng16 } from './png16';
import { frameName } from './sequence';
import { META_NAME, type Sink } from './sinks';
import { Mp4Encoder } from './mp4';

export interface FrameWriter {
  /** Peut-on sauter les images déjà écrites (séquence de fichiers) ? */
  readonly resumable: boolean;
  existing(): Promise<Set<number>>;
  readMeta(): Promise<string | null>;
  writeMeta(text: string): Promise<void>;
  /** `px` : flottants RGBA display-referred, ligne 0 = haut. Appelé dans l'ordre des images. */
  write(frame: number, px: Float32Array, w: number, h: number): Promise<void>;
  /** Termine et renvoie un message pour l'interface. */
  finish(): Promise<string>;
  /** Abandonne et renvoie un message pour l'interface. */
  abort(): Promise<string>;
}

/** Séquence de PNG 16 bits `shot_00001.png` dans une destination (dossier ou ZIP). */
export function pngWriter(sink: Sink): FrameWriter {
  return {
    resumable: true,
    existing: () => sink.existing(),
    readMeta: () => sink.readMeta(),
    writeMeta: (text) => sink.write(META_NAME, text),
    async write(frame, px, w, h) { await sink.write(frameName(frame), await encodePng16(px, w, h)); },
    finish: () => sink.finish(),
    async abort() { return sink.abort(); },
  };
}

/** Aperçu MP4 : toutes les images d'un trait, fichier écrit à la fin dans `sink` (dossier ou téléchargement). */
export function mp4Writer(sink: Sink, encoder: Mp4Encoder, fileName = 'shot_preview.mp4'): FrameWriter {
  return {
    resumable: false,
    async existing() { return new Set<number>(); },
    async readMeta() { return null; },
    async writeMeta() { /* pas de sidecar : pas de reprise pour une vidéo */ },
    async write(frame, px) { await encoder.add(frame, px); },
    async finish() {
      await sink.write(fileName, await encoder.finish());
      return sink.finish();
    },
    async abort() { await encoder.cancel(); return 'Interrompu : la vidéo partielle est abandonnée.'; },
  };
}
