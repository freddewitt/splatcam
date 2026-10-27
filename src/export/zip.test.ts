import { describe, expect, it } from 'vitest';
import { crc32 } from './crc32';
import { buildZip } from './zip';

describe('buildZip', () => {
  const a = new TextEncoder().encode('bonjour'), b = new Uint8Array([1, 2, 3, 4, 5]);
  const zip = buildZip([{ name: 'shot_00001.png', data: a }, { name: 'shot_00002.png', data: b }]);
  const v = new DataView(zip.buffer);

  it('termine par un répertoire central cohérent', () => {
    const end = zip.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    const cdOffset = v.getUint32(end + 16, true), cdSize = v.getUint32(end + 12, true);
    expect(cdOffset + cdSize).toBe(end);
    expect(v.getUint32(cdOffset, true)).toBe(0x02014b50);
  });

  it('stocke les données, CRC et tailles justes, et le décalage de chaque entrée', () => {
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint32(14, true)).toBe(crc32(a));
    expect(v.getUint32(18, true)).toBe(a.length);
    const nameLen = v.getUint16(26, true);
    expect(new TextDecoder().decode(zip.subarray(30, 30 + nameLen))).toBe('shot_00001.png');
    expect(zip.subarray(30 + nameLen, 30 + nameLen + a.length)).toEqual(a);
    const second = 30 + nameLen + a.length;
    expect(v.getUint32(second, true)).toBe(0x04034b50);
    // Le répertoire central désigne bien la 2e entrée.
    const end = zip.length - 22, cd = v.getUint32(end + 16, true);
    const firstLen = 46 + v.getUint16(cd + 28, true);
    expect(v.getUint32(cd + firstLen + 42, true)).toBe(second);
  });

  it('est déterministe', () => {
    expect(buildZip([{ name: 'a', data: a }])).toEqual(buildZip([{ name: 'a', data: a }]));
  });
});
