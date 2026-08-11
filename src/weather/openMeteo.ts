import { getLocal, removeLocal, setLocal } from '../lib/chrome';

export const OPEN_METEO_FORECAST_ORIGIN = 'https://api.open-meteo.com/*';
export const OPEN_METEO_GEOCODING_ORIGIN = 'https://geocoding-api.open-meteo.com/*';
export const REVERSE_GEOCODING_ORIGIN = 'https://api.bigdatacloud.net/*';
export const OPEN_METEO_ORIGINS = [OPEN_METEO_FORECAST_ORIGIN, OPEN_METEO_GEOCODING_ORIGIN, REVERSE_GEOCODING_ORIGIN] as const;

const WEATHER_CACHE_KEY = 'pictab-weather-cache-v1';
const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 10_000;
let queuedWeatherCacheWrite: Promise<void> = Promise.resolve();

export interface CityResult {
  id: number;
  name: string;
  label: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}

export interface WeatherLocation {
  location: string;
  latitude: number;
  longitude: number;
}

export interface WeatherSnapshot {
  location: string;
  temperature: number;
  temperatureUnit: string;
  weatherCode: number;
  isDay: boolean;
  fetchedAt: number;
  stale: boolean;
}

export interface WeatherCache {
  get(key: string): Promise<WeatherSnapshot | undefined>;
  set(key: string, value: WeatherSnapshot): Promise<void>;
  clear?(): Promise<void>;
}

export class WeatherServiceError extends Error {
  constructor(public readonly code: 'validation' | 'network' | 'http' | 'parse', message: string) {
    super(message);
    this.name = 'WeatherServiceError';
  }
}

export class MemoryWeatherCache implements WeatherCache {
  private readonly values = new Map<string, WeatherSnapshot>();
  async get(key: string) { const value = this.values.get(key); return value ? { ...value } : undefined; }
  async set(key: string, value: WeatherSnapshot) { this.values.set(key, { ...value }); }
  async clear() { this.values.clear(); }
}

export class ChromeWeatherCache implements WeatherCache {
  async get(key: string): Promise<WeatherSnapshot | undefined> {
    const values = await readChromeCache();
    return safeSnapshot(values[key]);
  }

  async set(key: string, value: WeatherSnapshot): Promise<void> {
    const write = queuedWeatherCacheWrite.then(async () => {
      const current = await readChromeCache();
      const next = Object.fromEntries(
        Object.entries({ ...current, [key]: { ...value, stale: false } })
          .filter(([, item]) => safeSnapshot(item))
          .sort((a, b) => (safeSnapshot(b[1])?.fetchedAt ?? 0) - (safeSnapshot(a[1])?.fetchedAt ?? 0))
          .slice(0, 8)
      );
      await setLocal(WEATHER_CACHE_KEY, next);
    });
    queuedWeatherCacheWrite = write.catch(() => undefined);
    return write;
  }

  async clear(): Promise<void> {
    const write = queuedWeatherCacheWrite.then(() => removeLocal(WEATHER_CACHE_KEY));
    queuedWeatherCacheWrite = write.catch(() => undefined);
    return write;
  }
}

export interface OpenMeteoServiceOptions {
  fetcher?: typeof fetch;
  cache?: WeatherCache;
  now?: () => number;
  timeoutMs?: number;
}

export class OpenMeteoService {
  private readonly fetcher: typeof fetch;
  private readonly cache: WeatherCache;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private cacheEpoch = 0;
  private clearing = false;

  constructor(options: OpenMeteoServiceOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.cache = options.cache ?? new ChromeWeatherCache();
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async searchCities(query: string, locale = ''): Promise<CityResult[]> {
    const normalized = query.trim();
    if (normalized.length < 2 || normalized.length > 100) throw new WeatherServiceError('validation', '请输入至少两个字符的城市名称。');
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.searchParams.set('name', normalized);
    url.searchParams.set('count', '6');
    url.searchParams.set('language', languageFromLocale(locale));
    url.searchParams.set('format', 'json');
    const raw = await this.fetchJson(url.toString());
    if (!isRecord(raw)) throw new WeatherServiceError('parse', '天气服务返回了无法识别的数据。');
    const results = Array.isArray(raw.results) ? raw.results : [];
    return results.slice(0, 6).flatMap((value) => normalizeCity(value, locale));
  }

  async current(location: WeatherLocation): Promise<WeatherSnapshot> {
    const normalized = normalizeLocation(location);
    const key = weatherCacheKey(normalized);
    const requestEpoch = this.cacheEpoch;
    try {
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.searchParams.set('latitude', String(normalized.latitude));
      url.searchParams.set('longitude', String(normalized.longitude));
      url.searchParams.set('current', 'temperature_2m,weather_code,is_day');
      url.searchParams.set('forecast_days', '1');
      url.searchParams.set('timezone', 'auto');
      const raw = await this.fetchJson(url.toString());
      const snapshot = normalizeCurrent(raw, normalized.location, this.now());
      if (!this.clearing && requestEpoch === this.cacheEpoch) await this.cache.set(key, snapshot).catch(() => undefined);
      return snapshot;
    } catch (error) {
      const cached = await this.cache.get(key).catch(() => undefined);
      if (cached) return { ...cached, stale: true };
      if (error instanceof WeatherServiceError && error.code === 'validation') throw error;
      throw new WeatherServiceError('network', '暂时无法获取天气，请稍后重试。');
    }
  }

  async clearCache(): Promise<void> {
    this.cacheEpoch += 1;
    this.clearing = true;
    try { await this.cache.clear?.(); }
    finally { this.clearing = false; }
  }

  private async fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const fetcher = this.fetcher;
      const response = await fetcher(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal, credentials: 'omit' });
      if (!response.ok) throw new WeatherServiceError('http', response.status === 429 ? '天气服务繁忙，请稍后重试。' : '天气服务暂时不可用。');
      const text = await readBoundedText(response, controller);
      try { return JSON.parse(text) as unknown; }
      catch { throw new WeatherServiceError('parse', '天气服务返回了无法识别的数据。'); }
    } catch (error) {
      if (error instanceof WeatherServiceError) throw error;
      throw new WeatherServiceError('network', '暂时无法连接天气服务。');
    } finally { clearTimeout(timer); }
  }
}

export async function reverseGeocodeLocation(latitude: number, longitude: number, locale = '', fetcher: typeof fetch = fetch): Promise<string> {
  if (!validCoordinates(latitude, longitude)) throw new WeatherServiceError('validation', '未能读取有效的位置。');
  const url = new URL('https://api.bigdatacloud.net/data/reverse-geocode-client');
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set('localityLanguage', languageFromLocale(locale));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetcher(url.toString(), { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal, credentials: 'omit' });
    if (!response.ok) throw new WeatherServiceError('http', '暂时无法识别当前位置。');
    const text = await readBoundedText(response, controller, '位置服务返回的数据过大。');
    let raw: unknown;
    try { raw = JSON.parse(text) as unknown; }
    catch { throw new WeatherServiceError('parse', '位置服务返回了无法识别的数据。'); }
    if (!isRecord(raw)) throw new WeatherServiceError('parse', '位置服务返回了无法识别的数据。');
    const city = nonEmpty(raw.city) ?? nonEmpty(raw.locality);
    const region = nonEmpty(raw.principalSubdivision);
    const country = nonEmpty(raw.countryName);
    const label = localizedLocationLabel([city, region, country], locale);
    if (!label) throw new WeatherServiceError('parse', '未能识别当前位置的城市。');
    return label.slice(0, 160);
  } catch (error) {
    if (error instanceof WeatherServiceError) throw error;
    throw new WeatherServiceError('network', '暂时无法识别当前位置。');
  } finally { clearTimeout(timer); }
}

export function weatherCacheKey(input: WeatherLocation): string {
  const normalized = normalizeLocation(input);
  return `${normalized.location.trim().toLocaleLowerCase()}|${normalized.latitude.toFixed(5)}|${normalized.longitude.toFixed(5)}`;
}

export function describeWeatherCode(code: number, isDay: boolean, locale = 'zh-CN'): { icon: string; label: string } {
  const english = locale.toLowerCase().startsWith('en');
  if (code === 0) return { icon: isDay ? '☀' : '☾', label: english ? 'Clear' : '晴朗' };
  if ([1, 2, 3].includes(code)) return { icon: code === 1 ? (isDay ? '🌤' : '☁') : '☁', label: code === 1 ? (english ? 'Mostly clear' : '晴间多云') : (english ? 'Cloudy' : '多云') };
  if ([45, 48].includes(code)) return { icon: '≋', label: english ? 'Fog' : '有雾' };
  if ([51, 53, 55].includes(code)) return { icon: '🌦', label: english ? 'Drizzle' : '毛毛雨' };
  if ([56, 57, 66, 67].includes(code)) return { icon: '◇', label: english ? 'Freezing rain' : '冻雨' };
  if ([61, 63, 65].includes(code)) return { icon: '🌧', label: code === 61 ? (english ? 'Light rain' : '小雨') : (english ? 'Rain' : '降雨') };
  if ([71, 73, 75, 77].includes(code)) return { icon: '❄', label: english ? 'Snow' : '降雪' };
  if ([80, 81, 82].includes(code)) return { icon: '🌦', label: english ? 'Rain showers' : '阵雨' };
  if ([85, 86].includes(code)) return { icon: '❄', label: english ? 'Snow showers' : '阵雪' };
  if ([95, 96, 99].includes(code)) return { icon: 'ϟ', label: english ? 'Thunderstorm' : '雷暴' };
  return { icon: '·', label: english ? 'Weather' : '天气' };
}

function normalizeCity(value: unknown, locale: string): CityResult[] {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || typeof value.name !== 'string' || !validCoordinates(value.latitude, value.longitude)) return [];
  const name = value.name.trim().slice(0, 100); if (!name) return [];
  const country = nonEmpty(value.country); const admin1 = nonEmpty(value.admin1);
  const label = localizedLocationLabel([name, admin1, country], locale);
  return [{ id: value.id as number, name, label, latitude: value.latitude as number, longitude: value.longitude as number, ...(country ? { country } : {}), ...(admin1 ? { admin1 } : {}) }];
}

function localizedLocationLabel(parts: readonly (string | undefined)[], locale: string): string {
  return [...new Set(parts.filter((part): part is string => Boolean(part)))].join(locale.toLowerCase().startsWith('en') ? ', ' : '，');
}

async function readBoundedText(response: Response, controller: AbortController, tooLargeMessage = '天气服务返回的数据过大。'): Promise<string> {
  const declaredLength = response.headers.get('Content-Length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    controller.abort();
    await response.body?.cancel().catch(() => undefined);
    throw new WeatherServiceError('parse', tooLargeMessage);
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new WeatherServiceError('parse', tooLargeMessage);
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw new WeatherServiceError('parse', tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

function normalizeLocation(value: WeatherLocation): WeatherLocation {
  const location = typeof value.location === 'string' ? value.location.trim() : '';
  if (!location || location.length > 160 || !validCoordinates(value.latitude, value.longitude)) throw new WeatherServiceError('validation', '请选择有效的天气位置。');
  return { location, latitude: value.latitude, longitude: value.longitude };
}

function normalizeCurrent(value: unknown, location: string, fetchedAt: number): WeatherSnapshot {
  if (!isRecord(value) || !isRecord(value.current)) throw new WeatherServiceError('parse', '天气服务返回了无法识别的数据。');
  const current = value.current;
  if (!Number.isFinite(current.temperature_2m) || !Number.isInteger(current.weather_code) || ![0, 1].includes(current.is_day as number)) throw new WeatherServiceError('parse', '天气服务返回了不完整的数据。');
  const unit = isRecord(value.current_units) && typeof value.current_units.temperature_2m === 'string' ? value.current_units.temperature_2m : '°C';
  return { location, temperature: current.temperature_2m as number, temperatureUnit: unit.slice(0, 8), weatherCode: current.weather_code as number, isDay: current.is_day === 1, fetchedAt, stale: false };
}

function safeSnapshot(value: unknown): WeatherSnapshot | undefined {
  if (!isRecord(value) || typeof value.location !== 'string' || !Number.isFinite(value.temperature) || typeof value.temperatureUnit !== 'string' || !Number.isInteger(value.weatherCode) || typeof value.isDay !== 'boolean' || !Number.isFinite(value.fetchedAt)) return undefined;
  return { location: value.location.slice(0, 160), temperature: value.temperature as number, temperatureUnit: value.temperatureUnit.slice(0, 8), weatherCode: value.weatherCode as number, isDay: value.isDay, fetchedAt: value.fetchedAt as number, stale: Boolean(value.stale) };
}

async function readChromeCache(): Promise<Record<string, unknown>> {
  const value = await getLocal<unknown>(WEATHER_CACHE_KEY);
  return isRecord(value) ? value : {};
}

function validCoordinates(latitude: unknown, longitude: unknown): boolean {
  return typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}
function languageFromLocale(locale: string): string { const language = locale.trim().split(/[-_]/)[0]?.toLowerCase(); return language && /^[a-z]{2,3}$/.test(language) ? language : 'en'; }
function nonEmpty(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
