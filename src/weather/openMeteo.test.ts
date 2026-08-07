import { describe, expect, it, vi } from 'vitest';

import {
  MemoryWeatherCache,
  ChromeWeatherCache,
  OpenMeteoService,
  describeWeatherCode,
  reverseGeocodeLocation,
  weatherCacheKey
} from './openMeteo';

describe('OpenMeteoService', () => {
  it('searches the official geocoding endpoint and normalizes safe city results', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ results: [
      { id: 1, name: '上海', latitude: 31.2304, longitude: 121.4737, country: '中国', admin1: '上海' },
      { id: 2, name: 'bad', latitude: 999, longitude: 1 }
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const service = new OpenMeteoService({ fetcher });

    await expect(service.searchCities('上海', 'zh-CN')).resolves.toEqual([
      { id: 1, name: '上海', label: '上海，中国', latitude: 31.2304, longitude: 121.4737, country: '中国', admin1: '上海' }
    ]);
    const url = new URL(fetcher.mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe('https://geocoding-api.open-meteo.com/v1/search');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ name: '上海', count: '6', language: 'zh' });
  });

  it('bounds provider-controlled city names before returning labels to the UI', async () => {
    const huge = '城'.repeat(500);
    const service = new OpenMeteoService({ fetcher: vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ results: [{ id: 1, name: huge, latitude: 1, longitude: 2, country: huge }] }), { status: 200 })) });
    const [city] = await service.searchCities('城市');
    expect(city?.name).toHaveLength(100);
    expect(city?.country).toHaveLength(100);
    expect(city?.label.length).toBeLessThanOrEqual(201);
  });

  it('resolves current coordinates to a bounded city label on the client reverse-geocoding endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      city: '上海',
      principalSubdivision: '上海市',
      countryName: '中国'
    }), { status: 200 }));

    await expect(reverseGeocodeLocation(31.2, 121.4, 'zh-CN', fetcher)).resolves.toBe('上海，上海市，中国');
    const url = new URL(fetcher.mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe('https://api.bigdatacloud.net/data/reverse-geocode-client');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ latitude: '31.2', longitude: '121.4', localityLanguage: 'zh' });
  });

  it('aborts reverse geocoding at the shared weather deadline', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetcher = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () => reject(new Error('private provider timeout')));
        setTimeout(() => reject(new Error('missing abort signal')), 10_001);
      }));
      const pending = reverseGeocodeLocation(31.2, 121.4, 'zh-CN', fetcher);
      const assertion = expect(pending).rejects.toMatchObject({ code: 'network', message: '暂时无法识别当前位置。' });

      await vi.advanceTimersByTimeAsync(10_001);

      await assertion;
      expect(signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('cancels an oversized streamed reverse-geocoding response', async () => {
    const cancelled = vi.fn();
    let closeTimer: ReturnType<typeof setTimeout>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700_000));
        controller.enqueue(new Uint8Array(400_001));
        closeTimer = setTimeout(() => controller.close(), 50);
      },
      cancel() { clearTimeout(closeTimer); cancelled(); }
    });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));

    await expect(reverseGeocodeLocation(31.2, 121.4, 'zh-CN', fetcher))
      .rejects.toMatchObject({ code: 'parse', message: '位置服务返回的数据过大。' });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('fetches and normalizes current weather for one exact coordinate location', async () => {
    const now = vi.fn(() => 123_456);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      current: { temperature_2m: 22.6, weather_code: 2, is_day: 1 },
      current_units: { temperature_2m: '°C' }
    }), { status: 200 }));
    const service = new OpenMeteoService({ fetcher, now });

    await expect(service.current({ location: '上海', latitude: 31.2304, longitude: 121.4737 })).resolves.toEqual({
      location: '上海', temperature: 22.6, temperatureUnit: '°C', weatherCode: 2, isDay: true, fetchedAt: 123_456, stale: false
    });
    const url = new URL(fetcher.mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(url.searchParams.get('current')).toBe('temperature_2m,weather_code,is_day');
    expect(url.searchParams.get('forecast_days')).toBe('1');
  });

  it('calls the configured fetcher without binding the service instance as this', async () => {
    const fetcher = vi.fn(async function (this: unknown) {
      if (this !== undefined) throw new TypeError('Illegal invocation');
      return new Response(JSON.stringify({ results: [{ id: 1, name: '上海', latitude: 31.2304, longitude: 121.4737 }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const service = new OpenMeteoService({ fetcher });

    await expect(service.searchCities('上海', 'zh-CN')).resolves.toEqual([
      { id: 1, name: '上海', label: '上海', latitude: 31.2304, longitude: 121.4737 }
    ]);
  });

  it('still returns fresh weather when optional cache persistence fails', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ current: { temperature_2m: 18, weather_code: 1, is_day: 1 } }), { status: 200 }));
    const cache = { get: vi.fn(async () => undefined), set: vi.fn(async () => { throw new Error('quota'); }) };
    const service = new OpenMeteoService({ fetcher, cache });

    await expect(service.current({ location: '上海', latitude: 31.2, longitude: 121.4 })).resolves.toMatchObject({ location: '上海', temperature: 18, stale: false });
  });

  it('falls back only to the cache for the same location after a bounded network failure', async () => {
    const cache = new MemoryWeatherCache();
    const location = { location: '上海', latitude: 31.23, longitude: 121.47 };
    await cache.set(weatherCacheKey(location), { location: '上海', temperature: 21, temperatureUnit: '°C', weatherCode: 3, isDay: false, fetchedAt: 100, stale: false });
    await cache.set(weatherCacheKey({ location: '北京', latitude: 39.9, longitude: 116.4 }), { location: '北京', temperature: 4, temperatureUnit: '°C', weatherCode: 0, isDay: true, fetchedAt: 100, stale: false });
    const service = new OpenMeteoService({ fetcher: vi.fn<typeof fetch>(async () => { throw new Error('secret upstream body'); }), cache });

    await expect(service.current(location)).resolves.toMatchObject({ location: '上海', temperature: 21, stale: true });
    await expect(service.current({ location: '广州', latitude: 23.1, longitude: 113.2 })).rejects.toMatchObject({ code: 'network', message: '暂时无法获取天气，请稍后重试。' });
  });

  it('rejects short city queries and invalid coordinates before a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = new OpenMeteoService({ fetcher });
    await expect(service.searchCities(' a ')).rejects.toMatchObject({ code: 'validation' });
    await expect(service.current({ location: 'X', latitude: Number.NaN, longitude: 0 })).rejects.toMatchObject({ code: 'validation' });
    await expect(service.current({ location: 'X', latitude: 91, longitude: 0 })).rejects.toMatchObject({ code: 'validation' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('aborts a weather request at its configured deadline without exposing the thrown error', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('private network detail')));
    }));
    const service = new OpenMeteoService({ fetcher, timeoutMs: 500 });
    const pending = service.current({ location: '上海', latitude: 31.2, longitude: 121.4 });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'network', message: '暂时无法获取天气，请稍后重试。' });
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    vi.useRealTimers();
  });

  it('cancels a streamed response as soon as its decoded bytes exceed the limit', async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(700_000)); controller.enqueue(new Uint8Array(400_001)); },
      cancel: cancelled
    });
    const service = new OpenMeteoService({ fetcher: vi.fn<typeof fetch>(async () => new Response(body, { status: 200 })) });

    await expect(service.searchCities('上海')).rejects.toMatchObject({ code: 'parse', message: '天气服务返回的数据过大。' });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('serializes cache mutations across instances so overlapping locations are preserved', async () => {
    let stored: Record<string, unknown> = {};
    vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ 'pictab-weather-cache-v1': stored }));
    vi.mocked(chrome.storage.local.set).mockImplementation(async (value) => { stored = (value as Record<string, unknown>)['pictab-weather-cache-v1'] as Record<string, unknown>; });
    const first = new ChromeWeatherCache(); const second = new ChromeWeatherCache();
    const a = { location: '上海', temperature: 20, temperatureUnit: '°C', weatherCode: 0, isDay: true, fetchedAt: 1, stale: false };
    const b = { location: '北京', temperature: 10, temperatureUnit: '°C', weatherCode: 2, isDay: true, fetchedAt: 2, stale: false };

    await Promise.all([first.set('shanghai', a), second.set('beijing', b)]);

    await expect(first.get('shanghai')).resolves.toMatchObject({ location: '上海' });
    await expect(second.get('beijing')).resolves.toMatchObject({ location: '北京' });
  });

  it('invalidates an in-flight request before clearing so stale weather cannot be written afterward', async () => {
    let resolveFetch!: (response: Response) => void;
    const cache = { get: vi.fn(async () => undefined), set: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) };
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const service = new OpenMeteoService({ fetcher, cache });
    const pending = service.current({ location: '上海', latitude: 31.2, longitude: 121.4 });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());

    await service.clearCache();
    resolveFetch(new Response(JSON.stringify({ current: { temperature_2m: 20, weather_code: 0, is_day: 1 } }), { status: 200 }));
    await pending;

    expect(cache.clear).toHaveBeenCalledOnce();
    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe('describeWeatherCode', () => {
  it.each([
    [0, '晴朗'], [2, '多云'], [45, '有雾'], [53, '毛毛雨'], [61, '小雨'], [66, '冻雨'],
    [73, '降雪'], [80, '阵雨'], [85, '阵雪'], [95, '雷暴'], [999, '天气']
  ])('maps WMO code %i to %s', (code, label) => {
    expect(describeWeatherCode(code, true).label).toBe(label);
  });
});
