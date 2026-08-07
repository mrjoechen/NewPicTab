import { describe, expect, it } from 'vitest';

import { chooseClockTextTone, clockToneSampleRect } from './backgroundTone';

describe('background text tone', () => {
  it('uses dark clock text on bright sampled backgrounds', () => {
    const pixels = new Uint8ClampedArray([
      248, 246, 238, 255,
      238, 232, 218, 255,
      255, 255, 255, 255
    ]);

    expect(chooseClockTextTone(pixels)).toBe('dark');
  });

  it('uses light clock text on dark sampled backgrounds', () => {
    const pixels = new Uint8ClampedArray([
      8, 14, 20, 255,
      24, 30, 36, 255,
      40, 34, 28, 255
    ]);

    expect(chooseClockTextTone(pixels)).toBe('light');
  });

  it('samples the clock quadrant that matches its saved position', () => {
    expect(clockToneSampleRect('top-left', 48, 48)).toEqual({ x: 0, y: 0, width: 24, height: 24 });
    expect(clockToneSampleRect('center', 48, 48)).toEqual({ x: 12, y: 12, width: 24, height: 24 });
    expect(clockToneSampleRect('bottom-right', 48, 48)).toEqual({ x: 24, y: 24, width: 24, height: 24 });
  });
});
