import type { WidgetPosition } from '../domain/types';

export type ClockTextTone = 'light' | 'dark';

export interface SampleRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SAMPLE_SIZE = 48;

export async function detectClockTextTone(url: string, position: WidgetPosition): Promise<ClockTextTone | null> {
  try {
    if (!canSampleCanvas()) return null;
    const image = await loadToneImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    drawImageCover(context, image, SAMPLE_SIZE, SAMPLE_SIZE);
    const rect = clockToneSampleRect(position, SAMPLE_SIZE, SAMPLE_SIZE);
    return chooseClockTextTone(context.getImageData(rect.x, rect.y, rect.width, rect.height).data);
  } catch {
    return null;
  }
}

export function chooseClockTextTone(pixels: Uint8ClampedArray): ClockTextTone {
  let total = 0;
  let count = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3]! / 255;
    if (alpha < 0.2) continue;
    const red = pixels[index]!;
    const green = pixels[index + 1]!;
    const blue = pixels[index + 2]!;
    total += relativeLuminance(red, green, blue) * alpha;
    count += alpha;
  }
  const luminance = count > 0 ? total / count : 0;
  return luminance > 0.52 ? 'dark' : 'light';
}

export function clockToneSampleRect(position: WidgetPosition, width: number, height: number): SampleRect {
  const sampleWidth = Math.max(1, Math.floor(width / 2));
  const sampleHeight = Math.max(1, Math.floor(height / 2));
  const centeredX = Math.floor((width - sampleWidth) / 2);
  const centeredY = Math.floor((height - sampleHeight) / 2);
  const x = position.endsWith('left') ? 0 : position.endsWith('right') ? width - sampleWidth : centeredX;
  const y = position.startsWith('top') ? 0 : position.startsWith('bottom') ? height - sampleHeight : centeredY;
  return { x, y, width: sampleWidth, height: sampleHeight };
}

function relativeLuminance(red: number, green: number, blue: number): number {
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function drawImageCover(context: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number): void {
  const sourceWidth = image.naturalWidth || image.width || width;
  const sourceHeight = image.naturalHeight || image.height || height;
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = width / height;
  let sx = 0;
  let sy = 0;
  let sw = sourceWidth;
  let sh = sourceHeight;
  if (sourceRatio > targetRatio) {
    sw = sourceHeight * targetRatio;
    sx = (sourceWidth - sw) / 2;
  } else if (sourceRatio < targetRatio) {
    sh = sourceWidth / targetRatio;
    sy = (sourceHeight - sh) / 2;
  }
  context.drawImage(image, sx, sy, sw, sh, 0, 0, width, height);
}

function loadToneImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.decoding = 'async';
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      image.removeEventListener?.('load', onLoad);
      image.removeEventListener?.('error', onError);
      if (error === undefined) resolve(image);
      else reject(error);
    };
    const onLoad = () => finish();
    const onError = () => finish(new Error('Image tone sampling failed.'));
    image.addEventListener('load', onLoad, { once: true });
    image.addEventListener('error', onError, { once: true });
    image.src = url;
    if (typeof image.decode === 'function') void image.decode().then(() => finish(), finish);
  });
}

function canSampleCanvas(): boolean {
  return !/\bjsdom\b/i.test(navigator.userAgent);
}
