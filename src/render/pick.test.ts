import { describe, expect, it } from 'vitest';
import { pickDepth } from './pick';

const O = [0, 0, 0] as const, FWD = [0, 0, -1] as const;
const centers = (...pts: [number, number, number][]) => new Float32Array(pts.flat());

describe('pickDepth', () => {
  it('retourne la profondeur du premier splat opaque sur le rayon', () => {
    const d = pickDepth({ centers: centers([0, 0, -3], [0, 0, -7]) }, O, FWD, [0, 0, -1], 0.002);
    expect(d).toBeCloseTo(3, 5);
  });

  it('ignore les splats hors du rayon', () => {
    const d = pickDepth({ centers: centers([2, 0, -3], [0, 0, -7]) }, O, FWD, [0, 0, -1], 0.002);
    expect(d).toBeCloseTo(7, 5);
  });

  it('un splat translucide laisse passer : la profondeur est celle où l\'opacité cumulée dépasse 50 %', () => {
    const data = { centers: centers([0, 0, -2], [0, 0, -4], [0, 0, -9]), opacity: new Float32Array([0.3, 0.3, 0.9]) };
    expect(pickDepth(data, O, FWD, [0, 0, -1], 0.002)).toBeCloseTo(4, 5); // T = 0,7 · 0,7 = 0,49 < 0,5 au 2e splat
  });

  it('opacité cumulée jamais > 50 % : retient le splat le plus contributif', () => {
    const data = { centers: centers([0, 0, -2], [0, 0, -6]), opacity: new Float32Array([0.1, 0.3]) };
    expect(pickDepth(data, O, FWD, [0, 0, -1], 0.002)).toBeCloseTo(6, 5);
  });

  it('la profondeur est mesurée sur l\'axe optique, pas le long du rayon', () => {
    const dir = [Math.sin(0.2), 0, -Math.cos(0.2)] as const;
    const t = 5;
    const c = centers([dir[0] * t, 0, dir[2] * t]);
    expect(pickDepth({ centers: c }, O, FWD, dir, 0.002)).toBeCloseTo(t * Math.cos(0.2), 5);
  });

  it('rien sur le rayon : null', () => {
    expect(pickDepth({ centers: centers([5, 5, -3]) }, O, FWD, [0, 0, -1], 0.002)).toBeNull();
  });

  it('ignore les splats derrière la caméra', () => {
    expect(pickDepth({ centers: centers([0, 0, 3]) }, O, FWD, [0, 0, -1], 0.002)).toBeNull();
  });
});
