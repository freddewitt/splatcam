// Archive ZIP « stored » (sans compression) : les PNG sont déjà compressés, on ne refait pas de deflate.
// Repli quand l'API File System Access n'est pas disponible. Pas de ZIP64 : 4 Gio et 65 535 entrées au plus.

import { crc32 } from './crc32';

export interface ZipEntry { name: string; data: Uint8Array }

const MAX_SIZE = 0xffffffff;

export function buildZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length > 0xffff) throw new Error('ZIP : plus de 65 535 fichiers');
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);           // version requise
    lv.setUint16(6, 0x0800, true);       // noms en UTF-8
    lv.setUint16(8, 0, true);            // méthode 0 : stored
    lv.setUint16(12, 0x21, true);        // date 1980-01-01 (déterministe)
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, e.data);
    centrals.push(central);
    offset += local.length + e.data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  if (offset + centralSize > MAX_SIZE) throw new Error('ZIP : plus de 4 Gio (choisir un dossier plutôt qu\'un zip)');
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
