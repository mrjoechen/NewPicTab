import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDefaultSettings } from '../src/domain/defaults';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(projectRoot, 'dist');

let context: BrowserContext;
let page: Page;
let temporaryRoot: string;

test.beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), 'newpictab-clock-e2e-'));
  const profilePath = path.join(temporaryRoot, 'profile');
  context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: false,
    locale: 'zh-CN',
    viewport: { width: 2000, height: 1268 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });
  await context.addInitScript((timestamp) => {
    const NativeDate = Date;
    class FixedDate extends NativeDate {
      constructor(value?: string | number) {
        if (arguments.length === 0) super(timestamp);
        else super(value as string | number);
      }
      static now() { return timestamp; }
    }
    Object.defineProperty(globalThis, 'Date', { configurable: true, value: FixedDate });
  }, new Date('2026-08-11T12:59:59').valueOf());

  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent('serviceworker', { timeout: 10_000 });
  const extensionId = new URL(worker.url()).host;
  page = context.pages()[0] ?? await context.newPage();
  await page.goto('chrome://newtab');
  await page.waitForURL(`chrome-extension://${extensionId}/newtab.html`);
});

test.afterAll(async () => {
  await context?.close();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

test('keeps every clock format on one visible line across responsive viewports', async () => {
  for (const viewport of [
    { name: 'desktop', width: 2000, height: 1268 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'above mobile breakpoint', width: 641, height: 900 },
    { name: 'mobile breakpoint', width: 640, height: 900 },
    { name: 'mobile', width: 375, height: 812 },
    { name: 'narrow mobile', width: 320, height: 568 }
  ]) {
    await page.setViewportSize(viewport);
    for (const format of [
      { hour12: false, showSeconds: false },
      { hour12: false, showSeconds: true },
      { hour12: true, showSeconds: false },
      { hour12: true, showSeconds: true }
    ]) {
      await seedClock({ ...format, scale: 1.35 });
      await page.reload();

      const clock = page.getByTestId('clock');
      if (format.hour12) await expect(clock).toContainText(/上午|下午/);
      const metrics = await clock.evaluate((element) => {
        const rects: DOMRect[] = [];
        for (const number of element.querySelectorAll('.clock-weather__time-number')) {
          const text = number.firstChild;
          if (!text?.textContent) continue;
          for (let index = 0; index < text.textContent.length; index += 1) {
            if (/\s/.test(text.textContent[index]!)) continue;
            const range = document.createRange();
            range.setStart(text, index);
            range.setEnd(text, index + 1);
            rects.push(range.getBoundingClientRect());
          }
        }
        const clockRect = element.getBoundingClientRect();
        const valueRect = element.querySelector('.clock-weather__time-value')?.getBoundingClientRect();
        const dayPeriodRect = element.querySelector('.clock-weather__day-period')?.getBoundingClientRect();
        return {
          topSpread: Math.max(...rects.map((rect) => rect.top)) - Math.min(...rects.map((rect) => rect.top)),
          left: clockRect.left,
          right: clockRect.right,
          viewportWidth: window.innerWidth,
          centerDelta: valueRect && dayPeriodRect
            ? Math.abs((valueRect.top + valueRect.bottom - dayPeriodRect.top - dayPeriodRect.bottom) / 2)
            : null
        };
      });
      const caseName = `${viewport.name}, ${format.hour12 ? '12' : '24'} hour, ${format.showSeconds ? 'seconds' : 'minutes'}`;
      expect(metrics.topSpread, `${caseName}: time wrapped`).toBeLessThanOrEqual(1);
      expect(metrics.left, `${caseName}: time overflowed left`).toBeGreaterThanOrEqual(0);
      expect(metrics.right, `${caseName}: time overflowed right`).toBeLessThanOrEqual(metrics.viewportWidth);
      if (format.hour12) expect(metrics.centerDelta ?? Number.POSITIVE_INFINITY, `${caseName}: day period was not vertically centered`).toBeLessThanOrEqual(1);
    }
  }
});

async function seedClock(clock: { hour12: boolean; showSeconds: boolean; scale: number }): Promise<void> {
  const settings = createDefaultSettings();
  Object.assign(settings.widgets.clock, clock, { size: 'large', position: 'center' });
  await page.evaluate(async (value) => chrome.storage.local.set({ newpictab: value }), settings);
}
