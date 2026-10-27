// Aperçu MP4 : encodage WebCodecs (VideoEncoder, via Mediabunny) et écriture du conteneur MP4 en mémoire.
// Les codecs réellement disponibles dépendent du navigateur et de la machine : on les interroge à l'exécution
// (`canEncodeVideo`), on ne les suppose pas.

import { BufferTarget, Mp4OutputFormat, Output, QUALITY_HIGH, VideoSample, VideoSampleSource, canEncodeVideo, type VideoCodec } from 'mediabunny';
import { rgbaToBytes } from './video-plan';

/** Codecs proposés dans l'ordre de préférence ; seuls ceux que Chrome sait encoder ici sont retenus. */
export const MP4_CODECS: { id: VideoCodec; label: string; ffmpeg: string }[] = [
  { id: 'avc', label: 'H.264 (AVC)', ffmpeg: 'h264' },
  { id: 'hevc', label: 'H.265 (HEVC)', ffmpeg: 'hevc' },
];

/** Codecs MP4 réellement encodables pour cette taille, cette cadence et ce débit (bit/s). */
export async function encodableCodecs(width: number, height: number, fps: number, bitrate: number): Promise<VideoCodec[]> {
  if (typeof VideoEncoder === 'undefined') return [];
  const out: VideoCodec[] = [];
  const supported = new Mp4OutputFormat().getSupportedVideoCodecs();
  for (const c of MP4_CODECS) {
    if (supported.includes(c.id) && await canEncodeVideo(c.id, { width, height, frameRate: fps, bitrate }).catch(() => false)) out.push(c.id);
  }
  return out;
}

/** Encodeur MP4 : une image après l'autre (avec contre-pression), fichier complet à la fin. */
export class Mp4Encoder {
  private readonly target = new BufferTarget();
  private readonly output: Output<Mp4OutputFormat, BufferTarget>;
  private readonly source: VideoSampleSource;
  private started = false;

  constructor(private readonly width: number, private readonly height: number, private readonly fps: number, codec: VideoCodec, bitrate: number) {
    this.output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: this.target });
    this.source = new VideoSampleSource({ codec, bitrate: bitrate || QUALITY_HIGH, keyFrameInterval: 2 });
    this.output.addVideoTrack(this.source, { frameRate: fps });
  }

  /** Ajoute l'image n° `index` (base 0) : flottants RGBA display-referred, ligne 0 = haut. */
  async add(index: number, px: Float32Array): Promise<void> {
    if (!this.started) { await this.output.start(); this.started = true; }
    const sample = new VideoSample(rgbaToBytes(px, this.width, this.height), {
      format: 'RGBA', codedWidth: this.width, codedHeight: this.height, timestamp: index / this.fps, duration: 1 / this.fps,
      // Les valeurs viennent de la chaîne de post en sRGB / Rec.709 : on le dit au conteneur.
      colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: false },
    });
    try { await this.source.add(sample); } finally { sample.close(); }
  }

  async finish(): Promise<Uint8Array> {
    await this.output.finalize();
    return new Uint8Array(this.target.buffer!);
  }

  async cancel(): Promise<void> {
    if (this.started) await this.output.cancel().catch(() => undefined);
  }
}
