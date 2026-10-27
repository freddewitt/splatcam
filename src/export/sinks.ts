// Destinations d'une séquence : dossier choisi (File System Access API) ou archive ZIP téléchargée.

import { parseFrameName } from './sequence';
import { buildZip, type ZipEntry } from './zip';

/** Nom du fichier qui garde les réglages de l'export (reprise, reproductibilité). */
export const META_NAME = 'shot_export.json';

export interface Sink {
  readonly kind: 'folder' | 'zip' | 'download';
  /** Numéros d'images (base 0) déjà écrits. */
  existing(): Promise<Set<number>>;
  readMeta(): Promise<string | null>;
  write(name: string, data: Uint8Array | string): Promise<void>;
  /** Termine et renvoie un message pour l'interface. */
  finish(): Promise<string>;
  /** Abandonne (le ZIP en mémoire est jeté, les fichiers déjà écrits dans un dossier restent). */
  abort(): string;
}

/** Sous-ensemble de l'API File System Access utilisé ici (absent des typages DOM par défaut). */
export interface DirHandle {
  name: string;
  entries(): AsyncIterableIterator<[string, { kind: 'file' | 'directory' }]>;
  getFileHandle(name: string, o?: { create?: boolean }): Promise<{
    getFile(): Promise<File>;
    createWritable(): Promise<{ write(d: BufferSource | string): Promise<void>; close(): Promise<void> }>;
  }>;
}

export const hasFolderPicker = (): boolean => typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

/** Demande un dossier à l'utilisateur ; à appeler directement depuis un geste (clic). Null si annulé. */
export async function pickFolderSink(): Promise<Sink | null> {
  let dir: DirHandle;
  try {
    dir = await (window as unknown as { showDirectoryPicker(o: { mode: string }): Promise<DirHandle> }).showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
  return folderSink(dir);
}

/** Destination dans un dossier déjà ouvert (File System Access API ou OPFS). */
export function folderSink(dir: DirHandle): Sink {
  return {
    kind: 'folder',
    async existing() {
      const done = new Set<number>();
      for await (const [name, h] of dir.entries()) {
        const i = h.kind === 'file' ? parseFrameName(name) : null;
        if (i !== null) done.add(i);
      }
      return done;
    },
    async readMeta() {
      try { return await (await (await dir.getFileHandle(META_NAME)).getFile()).text(); } catch { return null; }
    },
    async write(name, data) {
      // createWritable écrit dans un fichier temporaire validé à close() : une annulation en plein milieu ne laisse pas de PNG tronqué.
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(data as BufferSource | string);
      await w.close();
    },
    async finish() { return `Écrit dans le dossier « ${dir.name} ».`; },
    abort() { return `Interrompu : les images déjà écrites restent dans « ${dir.name} » (cocher « Reprendre » pour continuer).`; },
  };
}


/** Taille maximale d'une archive ZIP tenue en mémoire. */
export const ZIP_MAX_BYTES = 1.5 * 2 ** 30;

/** Archive en mémoire, téléchargée à la fin (repli sans File System Access API). */
export function zipSink(archiveName = 'shot.zip'): Sink {
  const entries: ZipEntry[] = [];
  let total = 0;
  return {
    kind: 'zip',
    async existing() { return new Set<number>(); },
    async readMeta() { return null; },
    async write(name, data) {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      // L'archive vit en mémoire : on s'arrête tôt plutôt qu'après des heures de rendu (limite ZIP 4 Gio, copie finale ×2).
      total += bytes.length;
      if (total > ZIP_MAX_BYTES) throw new Error(`archive trop lourde pour la mémoire (> ${(ZIP_MAX_BYTES / 2 ** 30).toFixed(1)} Gio) : choisir la destination « Dossier »`);
      entries.push({ name, data: bytes });
    },
    async finish() {
      const blob = new Blob([buildZip(entries) as BlobPart], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = archiveName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return `${entries.length} fichiers dans ${archiveName}.`;
    },
    abort() { entries.length = 0; total = 0; return 'Interrompu : l\'archive en mémoire est abandonnée (un dossier permet de reprendre).'; },
  };
}

/** Un fichier unique téléchargé tel quel (vidéo MP4 sans dossier choisi). */
export function downloadSink(): Sink {
  let last = '';
  return {
    kind: 'download',
    async existing() { return new Set<number>(); },
    async readMeta() { return null; },
    async write(name, data) {
      last = name;
      const url = URL.createObjectURL(new Blob([data as BlobPart]));
      const a = document.createElement('a');
      a.href = url; a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    async finish() { return last ? `Téléchargé : ${last}.` : 'Rien à télécharger.'; },
    abort() { return 'Interrompu.'; },
  };
}
