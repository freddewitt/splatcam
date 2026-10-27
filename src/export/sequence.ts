// Plan d'une séquence d'images : noms, instants, taille et reprise. Pur, sans GPU ni DOM.

/** `shot_00001.png` : numérotation à partir de 1, 5 chiffres. */
export function frameName(index: number, prefix = 'shot'): string {
  return `${prefix}_${String(index + 1).padStart(5, '0')}.png`;
}

/** Numéro d'image (base 0) lu dans un nom `shot_00042.png`, ou null. */
export function parseFrameName(name: string, prefix = 'shot'): number | null {
  const m = new RegExp(`^${prefix}_(\\d{5,})\\.png$`).exec(name);
  return m ? parseInt(m[1], 10) - 1 : null;
}

/** Nombre d'images d'un plan : la dernière seconde est exclue comme dans une vidéo (t = i / fps < durée). */
export function frameCount(durationS: number, fps: number): number {
  return Math.max(1, Math.round(durationS * fps));
}

/** Instant (s) de l'image `index` ; la graine du bruit en est déduite (`index`), donc la même image donne le même bruit. */
export function frameTime(index: number, fps: number): number {
  return index / fps;
}

/** Dimensions paires (encodeurs vidéo) au rapport `aspect` pour une hauteur demandée, bornées par la limite de texture. */
export function exportSize(height: number, aspect: number, maxDim: number): { w: number; h: number } {
  const even = (v: number) => Math.max(2, 2 * Math.round(v / 2));
  let h = even(height), w = even(h * aspect);
  const over = Math.max(w, h) / maxDim;
  if (over > 1) { h = even(h / over); w = even(h * aspect); }
  return { w, h };
}

/** Images restant à produire, dans l'ordre, en sautant celles déjà présentes (reprise). */
export function pendingFrames(total: number, done: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < total; i++) if (!done.has(i)) out.push(i);
  return out;
}

/** Empreinte courte et stable d'une chaîne (FNV-1a 32 bits) : détecte un réglage changé entre deux reprises. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** Sérialisation JSON à clés triées : deux états égaux donnent la même chaîne. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}
