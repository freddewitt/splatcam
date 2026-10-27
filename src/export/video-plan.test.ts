import { describe, expect, it } from 'vitest';
import { defaultBitrateMbps, ffmpegCommands, rgbaToBytes } from './video-plan';

describe('rgbaToBytes', () => {
  it('arrondit, écrête et force l\'alpha', () => {
    const out = rgbaToBytes(new Float32Array([0, 0.5, 1, 0.2, -1, 2, NaN, 0]), 2, 1);
    expect([...out]).toEqual([0, 128, 255, 255, 0, 255, 0, 255]);
  });
});

describe('defaultBitrateMbps', () => {
  it('1080p à 25 i/s ≈ 13 Mbit/s, croît avec la résolution, plancher 1', () => {
    expect(defaultBitrateMbps(1920, 1080, 25)).toBe(13);
    expect(defaultBitrateMbps(3840, 2160, 25)).toBeGreaterThan(40);
    expect(defaultBitrateMbps(64, 64, 25)).toBe(1);
  });
});

describe('ffmpegCommands', () => {
  const cmds = ffmpegCommands({ fps: 25 });
  it('ProRes 4444 et H.265 10 bits, cadence et motif des images', () => {
    expect(cmds).toHaveLength(2);
    expect(cmds[0].command).toContain('-framerate 25');
    expect(cmds[0].command).toContain('-i shot_%05d.png');
    expect(cmds[0].command).toContain('prores_ks -profile:v 4');
    expect(cmds[0].command).toContain('yuv444p10le');
    expect(cmds[1].command).toContain('libx265');
    expect(cmds[1].command).toContain('yuv420p10le');
    expect(cmds[1].command).toContain('hvc1');
  });
  it('la cadence suit le réglage', () => {
    expect(ffmpegCommands({ fps: 24 })[0].command).toContain('-framerate 24');
  });
});
