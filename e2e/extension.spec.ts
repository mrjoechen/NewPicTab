import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { chromium } from 'playwright';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(projectRoot, 'dist');

let context: BrowserContext;
let page: Page;
let temporaryRoot: string;
let extensionId: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), 'pictab-e2e-'));
  const profilePath = path.join(temporaryRoot, 'profile');
  const fixtureExtensionPath = path.join(temporaryRoot, 'extension');
  await cp(extensionPath, fixtureExtensionPath, { recursive: true });
  const fixtureManifestPath = path.join(fixtureExtensionPath, 'manifest.json');
  const fixtureManifest = JSON.parse(await readFile(fixtureManifestPath, 'utf8')) as Record<string, unknown>;
  fixtureManifest.host_permissions = ['https://images.test/*'];
  await writeFile(fixtureManifestPath, `${JSON.stringify(fixtureManifest, null, 2)}\n`);
  context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: false,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${fixtureExtensionPath}`,
      `--load-extension=${fixtureExtensionPath}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent('serviceworker', { timeout: 10_000 });
  extensionId = new URL(worker.url()).host;
  page = context.pages()[0] ?? await context.newPage();
  await page.goto('chrome://newtab');
  await page.waitForURL(`chrome-extension://${extensionId}/newtab.html`);
});

test.afterAll(async () => {
  await context?.close();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

test('loads the unpacked new-tab override with an offline-safe first paint', async () => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  await expect(page).toHaveURL(`chrome-extension://${extensionId}/newtab.html`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByAltText('A calm gradient background')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'PicTab' })).toBeAttached();
  await expect(page.getByLabel('开始使用 PicTab')).toBeVisible();

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByAltText('A calm gradient background')).toBeVisible();
  await expect(page.getByTestId('background-current')).toHaveAttribute('data-source-id', 'bundled');
  await context.setOffline(false);

  await page.getByRole('button', { name: '添加图片源' }).click();
  await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible();
  await page.getByRole('button', { name: '添加图片源' }).click();
  await expect(page.getByRole('button', { name: '本地图片' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'TMDB' })).toBeVisible();
});

test('activates a private local source and persists display preferences', async () => {
  await page.getByRole('button', { name: '本地图片' }).click();
  await page.getByLabel('图片源名称').fill('离线图库');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
  await page.getByLabel('导入本地图片').setInputFiles([
    { name: 'offline-one.png', mimeType: 'image/png', buffer: png },
    { name: 'offline-two.png', mimeType: 'image/png', buffer: png }
  ]);
  await page.getByRole('button', { name: '保存并使用' }).click();
  await expect(page.getByRole('heading', { name: '离线图库' })).toBeVisible();
  await expect(page.getByText('正在使用')).toBeVisible();
  await expect(page.getByTestId('background-current')).toHaveAttribute('style', /blob:chrome-extension/);

  await page.getByRole('button', { name: '动效' }).click();
  await page.getByLabel('图片顺序').selectOption('sequential');
  for (const transition of ['fade', 'slide', 'ken-burns', 'none'] as const) {
    await page.getByLabel('切换样式').selectOption(transition);
    await expect(page.getByTestId('background-stage')).toHaveAttribute('data-transition', transition);
  }
  await page.getByLabel('切换样式').selectOption('slide');
  await expect(page.getByTestId('background-stage')).toHaveAttribute('data-transition', 'slide');

  await page.getByRole('button', { name: '时间和日期' }).click();
  await page.getByLabel('显示时间').click();
  await expect(page.getByLabel('显示时间')).not.toBeChecked();
  await page.getByLabel('显示日期').click();
  await expect(page.getByLabel('显示日期')).not.toBeChecked();
  await expect(page.getByTestId('clock')).toHaveCount(0);
  await expect(page.getByTestId('date')).toHaveCount(0);

  await page.getByRole('button', { name: '搜索' }).click();
  await page.getByLabel('显示搜索').click();
  await expect(page.getByLabel('显示搜索')).toBeChecked();

  await page.getByRole('button', { name: '快捷网址' }).click();
  await page.getByLabel('显示快捷网址').click();
  await expect(page.getByLabel('显示快捷网址')).toBeChecked();
  await page.getByRole('button', { name: '添加快捷网址' }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('示例');
  await page.getByRole('textbox', { name: '网址', exact: true }).fill('https://example.com/');
  await page.getByRole('button', { name: '保存快捷网址' }).click();
  await page.getByRole('button', { name: '添加快捷网址' }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('第二项');
  await page.getByRole('textbox', { name: '网址', exact: true }).fill('https://second.example/');
  await page.getByRole('button', { name: '保存快捷网址' }).click();
  await page.getByRole('button', { name: '上移 第二项' }).click();
  await expect(page.getByTestId('shortcut-row').first()).toContainText('第二项');

  await page.getByRole('button', { name: '天气' }).click();
  await context.route('https://api.open-meteo.com/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ current: { temperature_2m: 20, weather_code: 0, is_day: 1 }, current_units: { temperature_2m: '°C' } })
  }));
  await seedWeatherToggle(page);
  await expect(page.getByLabel('显示天气')).toBeChecked();
  await page.getByLabel('轻微天气动效').click();
  await expect(page.getByLabel('轻微天气动效')).toBeChecked();
  await page.getByLabel('显示天气').click();
  await expect(page.getByLabel('显示天气')).not.toBeChecked();
  await context.unroute('https://api.open-meteo.com/**');
  await page.getByRole('button', { name: '关闭设置' }).click();

  const firstImageId = await page.getByTestId('background-current').getAttribute('data-image-id');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.getByTestId('background-current').getAttribute('data-image-id')).not.toBe(firstImageId);
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('background-current')).toHaveAttribute('data-image-id', firstImageId!);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('background-current')).toHaveAttribute('style', /blob:chrome-extension/);
  await expect(page.getByTestId('background-stage')).toHaveAttribute('data-transition', 'slide');
  await expect(page.getByRole('search')).toBeVisible();
  await expect(page.getByRole('link', { name: '打开 示例' })).toBeVisible();
  await expect(page.getByRole('link', { name: '打开 第二项' })).toBeVisible();
  await expect(page.getByTestId('clock')).toHaveCount(0);
  await expect(page.getByTestId('date')).toHaveCount(0);
  await context.setOffline(false);

  await context.route('https://www.google.com/search?**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Search fixture</title>' }));
  await page.getByRole('searchbox', { name: '搜索' }).fill('quiet coast');
  await page.getByRole('button', { name: '提交搜索' }).click();
  await page.waitForURL('https://www.google.com/search?**');
  expect(new URL(page.url()).searchParams.get('q')).toBe('quiet coast');
  await page.goto(`chrome-extension://${extensionId}/newtab.html`);
  await context.unroute('https://www.google.com/search?**');
});

test('activates a deterministic Direct source and switches back to local', async () => {
  const remoteUrl = 'https://images.test/pictab.png';
  await installDirectRuntimeFixture(page, remoteUrl);
  await expect.poll(() => page.evaluate(() => chrome.permissions.contains({ origins: ['https://images.test/*'] }))).toBe(true);

  await page.getByRole('button', { name: '打开设置' }).click();
  await page.getByRole('button', { name: '图片源', exact: true }).click();
  await page.getByRole('button', { name: '添加图片源' }).click();
  await page.getByRole('button', { name: '在线图片 URL' }).click();
  await page.getByLabel('图片源名称').fill('网络收藏');
  await page.getByLabel('图片 URL 1').fill(remoteUrl);
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByRole('status')).toContainText('连接成功');
  await expect(page.getByRole('img', { name: '图片预览' })).toHaveAttribute('src', /^blob:/);
  await page.getByRole('button', { name: '保存并使用' }).click();
  await expect(page.getByRole('heading', { name: '网络收藏' })).toBeVisible();
  const directId = await page.evaluate(async () => {
    const { pictab } = await chrome.storage.local.get('pictab') as { pictab: { sources: Array<{ id: string; name: string }> } };
    return pictab.sources.find((source) => source.name === '网络收藏')!.id;
  });
  await page.getByRole('button', { name: '关闭设置' }).click();
  await expect(page.getByTestId('background-current')).toHaveAttribute('data-source-id', directId);
  await expect(page.getByTestId('background-current')).toHaveAttribute('style', /blob:/);

  await page.getByRole('button', { name: '打开设置' }).click();
  const localCard = page.locator('.source-card').filter({ hasText: '离线图库' });
  await localCard.getByRole('button', { name: '使用此源' }).click();
  const localId = await page.evaluate(async () => {
    const { pictab } = await chrome.storage.local.get('pictab') as { pictab: { sources: Array<{ id: string; name: string }> } };
    return pictab.sources.find((source) => source.name === '离线图库')!.id;
  });
  await page.getByRole('button', { name: '关闭设置' }).click();
  await expect(page.getByTestId('background-current')).toHaveAttribute('data-source-id', localId);
  await page.reload();
});

test('shows privacy details and requires confirmation before clearing data', async () => {
  await page.getByRole('button', { name: '打开设置' }).click();
  await page.getByRole('button', { name: '关于' }).click();
  await expect(page.getByText('PicTab 不包含统计、遥测或跟踪')).toBeVisible();
  await expect(page.getByRole('link', { name: '申请 TMDB API 凭据' })).toHaveAttribute('rel', /noopener/);
  await page.getByRole('button', { name: '清除所有 PicTab 数据' }).click();
  const confirmation = page.getByRole('alertdialog', { name: '清除所有 PicTab 数据' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByText('设置与凭据')).toBeVisible();
  await confirmation.getByRole('button', { name: '取消' }).click();
  await expect(confirmation).toHaveCount(0);
});

async function seedWeatherToggle(target: Page): Promise<void> {
  await target.evaluate(async () => {
    const stored = await chrome.storage.local.get('pictab');
    const settings = stored.pictab as { widgets: { weather: unknown } };
    settings.widgets.weather = {
      enabled: true,
      mode: 'city',
      city: '测试城市',
      latitude: 0,
      longitude: 0,
      animated: false
    };
    await chrome.storage.local.set({ pictab: settings });
  });
}

async function installDirectRuntimeFixture(target: Page, remoteUrl: string): Promise<void> {
  await target.evaluate((url) => {
    const runtime = chrome.runtime as typeof chrome.runtime & { sendMessage: typeof chrome.runtime.sendMessage };
    const original = runtime.sendMessage.bind(runtime);
    const binary = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=');
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    Object.defineProperty(runtime, 'sendMessage', {
      configurable: true,
      value: ((message: { source?: string; config?: { id: string; type: string; entries?: Array<{ id: string }> } }, ...rest: unknown[]) => {
        const callback = rest.find((item): item is (value: unknown) => void => typeof item === 'function');
        if (message?.config?.type === 'direct' && callback) {
          const entryId = message.config.entries?.[0]?.id ?? 'fixture';
          if (message.source === 'test') callback({ ok: true, entries: [{ id: entryId, sourceId: message.config.id, url }] });
          else if (message.source === 'list') callback({ ok: true, images: [{ id: entryId, sourceId: message.config.id, url: blobUrl }], totalCount: 1, offset: 0, consumedCount: 1, nextOffset: 1, hasMore: false });
          else callback({ ok: true });
          return undefined;
        }
        return original(message as never, ...(rest as never[]));
      }) as typeof chrome.runtime.sendMessage
    });
  }, remoteUrl);
}
