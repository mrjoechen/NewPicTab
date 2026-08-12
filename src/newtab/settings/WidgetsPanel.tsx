import { useEffect, useRef, useState } from 'react';

import type { NewPicTabSettings, WidgetSettings } from '../../domain/types';
import { requestOriginPermissions } from '../../lib/permissions';
import type { WeatherBackgroundResponse } from '../../background/messages';
import { OPEN_METEO_ORIGINS, reverseGeocodeLocation, type CityResult, type WeatherLocation } from '../../weather/openMeteo';
import type { WeatherSnapshot } from '../../weather/openMeteo';
import type { SettingsUpdater } from './SourcesPanel';
import { validateSearchTemplate } from '../components/SearchBox';
import { SEARCH_ENGINES } from '../../domain/search';
import { Icon } from '../components/Icon';

export interface WeatherOperations {
  requestAccess: () => Promise<boolean>;
  searchCities: (query: string, locale: string) => Promise<CityResult[]>;
  reverseGeocode: (latitude: number, longitude: number, locale: string) => Promise<string>;
  getCurrent: (location: WeatherLocation) => Promise<WeatherBackgroundResponse>;
  getPosition: () => Promise<{ latitude: number; longitude: number }>;
}

export interface WidgetsPanelProps {
  section: 'time' | 'weather' | 'search';
  settings: NewPicTabSettings;
  onUpdate: SettingsUpdater;
  operations?: WeatherOperations;
  currentWeather?: WeatherSnapshot | null;
  onClockScalePreview?: (scale: number | null) => void;
}

const DEFAULT_OPERATIONS: WeatherOperations = {
  requestAccess: async () => (await requestOriginPermissions(OPEN_METEO_ORIGINS)).ok,
  searchCities: async (query, locale) => {
    const response = await sendWeatherMessage({ weather: 'city-search', query, locale });
    if (!response.ok || !('cities' in response)) throw new Error(response.ok ? '城市搜索失败。' : response.message);
    return response.cities;
  },
  reverseGeocode: (latitude, longitude, locale) => reverseGeocodeLocation(latitude, longitude, locale),
  getCurrent: (location) => sendWeatherMessage({ weather: 'current', ...location }),
  getPosition: () => new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('unsupported')); return; }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude }),
      () => reject(new Error('unavailable')),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 10 * 60_000 }
    );
  })
};

export function WidgetsPanel({ section, settings, onUpdate, operations = DEFAULT_OPERATIONS, currentWeather, onClockScalePreview }: WidgetsPanelProps) {
  if (section === 'time') return <TimeDatePanel value={settings.widgets} onUpdate={onUpdate} onClockScalePreview={onClockScalePreview} />;
  if (section === 'search') return <SearchPanel value={settings.widgets.search} onUpdate={onUpdate} />;
  return <WeatherPanel value={settings.widgets.weather} language={settings.interfaceLanguage} onUpdate={onUpdate} operations={operations} currentWeather={currentWeather} />;
}

function SearchPanel({ value, onUpdate }: { value: WidgetSettings['search']; onUpdate: SettingsUpdater }) {
  const [engine, setEngine] = useState<WidgetSettings['search']['engine']>(value.engine);
  const [template, setTemplate] = useState(value.engine === 'custom' ? value.customTemplate : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setEngine(value.engine);
    if (value.engine === 'custom') setTemplate(value.customTemplate);
  }, [value]);
  const patchSearch = async (resolve: (current: WidgetSettings['search']) => WidgetSettings['search']): Promise<boolean> => {
    setBusy(true); setError('');
    try {
      await onUpdate((current) => ({ ...current, widgets: { ...current.widgets, search: resolve(current.widgets.search) } }));
      return true;
    } catch { setError('无法保存搜索设置。'); return false; }
    finally { setBusy(false); }
  };
  const changeEngine = async (next: WidgetSettings['search']['engine']) => {
    setEngine(next); setError('');
    if (next !== 'custom' && !await patchSearch((current) => ({ enabled: current.enabled, engine: next }))) setEngine(value.engine);
  };
  const saveTemplate = async () => {
    const validation = validateSearchTemplate(template);
    if (validation) { setError(validation); return; }
    setError('');
    if (!await patchSearch((current) => ({ enabled: current.enabled, engine: 'custom', customTemplate: template }))) setEngine(value.engine);
  };
  const setEnabled = (enabled: boolean) => patchSearch((current) => ({ ...current, enabled }));
  return <section className="settings-section" aria-labelledby="search-title">
    <header className="settings-section__header"><h2 id="search-title">搜索</h2><p>搜索词会直接交给所选引擎，NewPicTab 不会记录。</p></header>
    <div className="settings-form">
      <label className="check-field"><input type="checkbox" checked={value.enabled} disabled={busy} onChange={(event) => void setEnabled(event.target.checked)} />显示搜索</label>
      <label className="field"><span>搜索引擎</span><select value={engine} disabled={busy} onChange={(event) => void changeEngine(event.target.value as WidgetSettings['search']['engine'])}>{Object.entries(SEARCH_ENGINES).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}<option value="custom">自定义</option></select></label>
      {engine === 'custom' && <><label className="field"><span>搜索模板</span><input value={template} disabled={busy} placeholder="https://search.example/?q={query}" onChange={(event) => setTemplate(event.target.value)} /></label><button className="button button--secondary button--with-icon" type="button" aria-label="保存搜索模板" title="保存搜索模板" disabled={busy} onClick={() => void saveTemplate()}><Icon name="save" /><span>保存</span></button></>}
      {error && <p className="form-message form-message--error" role="alert">{error}</p>}
    </div>
  </section>;
}

const CLOCK_SCALE_MIN = 0.45;
const CLOCK_SCALE_MAX = 1.35;
const DATE_LOCALES = [
  { value: '', label: '跟随界面语言' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English (US)' }
] as const;

function TimeDatePanel({ value, onUpdate, onClockScalePreview }: { value: WidgetSettings; onUpdate: SettingsUpdater; onClockScalePreview?: (scale: number | null) => void }) {
  const patchClock = (patch: Partial<WidgetSettings['clock']>) => void onUpdate((current) => ({ ...current, widgets: { ...current.widgets, clock: { ...current.widgets.clock, ...patch } } }));
  const patchDate = (patch: Partial<WidgetSettings['date']>) => void onUpdate((current) => ({ ...current, widgets: { ...current.widgets, date: { ...current.widgets.date, ...patch } } }));
  const savedScale = boundedClockScale(value.clock.scale);
  const [draftScale, setDraftScale] = useState(String(savedScale));
  useEffect(() => setDraftScale(String(savedScale)), [savedScale]);
  useEffect(() => () => onClockScalePreview?.(null), [onClockScalePreview]);
  const previewDraftScale = (value: string) => {
    const scale = boundedClockScale(Number(value));
    setDraftScale(String(scale));
    onClockScalePreview?.(scale);
  };
  const commitDraftScale = (nextValue = draftScale) => {
    const scale = boundedClockScale(Number(nextValue));
    if (Math.abs(scale - savedScale) > 0.004) patchClock({ scale, size: scaleToSize(scale) });
  };
  return <section className="settings-section" aria-labelledby="time-date-title">
    <header className="settings-section__header"><p className="settings-eyebrow">小组件</p><h2 id="time-date-title">时间和日期</h2><p>时间与日期可以独立显示。</p></header>
    <div className="settings-form">
      <label className="check-field"><input type="checkbox" checked={value.clock.enabled} onChange={(event) => patchClock({ enabled: event.target.checked })} />显示时间</label>
      <label className="field"><span>时间格式</span><select value={value.clock.hour12 ? '12' : '24'} disabled={!value.clock.enabled} onChange={(event) => patchClock({ hour12: event.target.value === '12' })}><option value="24">24 小时</option><option value="12">12 小时</option></select></label>
      <label className="check-field"><input type="checkbox" checked={value.clock.showSeconds} disabled={!value.clock.enabled} onChange={(event) => patchClock({ showSeconds: event.target.checked })} />显示秒数</label>
      <label className="field range-field"><span>文字大小</span><input aria-label="文字大小" type="range" min={CLOCK_SCALE_MIN} max={CLOCK_SCALE_MAX} step="0.01" value={draftScale} disabled={!value.clock.enabled && !value.date.enabled} onChange={(event) => previewDraftScale(event.target.value)} onPointerUp={(event) => commitDraftScale(event.currentTarget.value)} onPointerCancel={(event) => commitDraftScale(event.currentTarget.value)} onBlur={(event) => commitDraftScale(event.currentTarget.value)} /><small>{scaleLabel(draftScale)}</small></label>
      <label className="field"><span>显示位置</span><select value={value.clock.position} disabled={!value.clock.enabled && !value.date.enabled} onChange={(event) => patchClock({ position: event.target.value as WidgetSettings['clock']['position'] })}><option value="top-left">左上</option><option value="top-center">顶部居中</option><option value="top-right">右上</option><option value="center">居中</option><option value="bottom-left">左下</option><option value="bottom-center">底部居中</option><option value="bottom-right">右下</option></select></label>
      <div className="settings-divider" />
      <label className="check-field"><input type="checkbox" checked={value.date.enabled} onChange={(event) => patchDate({ enabled: event.target.checked })} />显示日期</label>
      <label className="check-field"><input type="checkbox" checked={value.date.showLunar} disabled={!value.date.enabled} onChange={(event) => patchDate({ showLunar: event.target.checked })} />显示农历</label>
      <label className="field"><span>日期格式</span><select value={value.date.format} disabled={!value.date.enabled} onChange={(event) => patchDate({ format: event.target.value as WidgetSettings['date']['format'] })}><option value="short">简短</option><option value="medium">标准</option><option value="long">详细</option><option value="full">完整</option></select></label>
      <label className="field"><span>日期语言</span><select value={value.date.locale} disabled={!value.date.enabled} onChange={(event) => patchDate({ locale: event.target.value })}>{value.date.locale && !DATE_LOCALES.some((option) => option.value === value.date.locale) && <option value={value.date.locale}>{value.date.locale}</option>}{DATE_LOCALES.map((option) => <option key={option.value || 'interface'} value={option.value}>{option.label}</option>)}</select></label>
    </div>
  </section>;
}

function boundedClockScale(value: number): number {
  return Number.isFinite(value) ? Math.min(CLOCK_SCALE_MAX, Math.max(CLOCK_SCALE_MIN, Math.round(value * 100) / 100)) : 1;
}

function scaleToSize(scale: number): WidgetSettings['clock']['size'] {
  return scale < 0.8 ? 'compact' : scale > 1.12 ? 'large' : 'default';
}

function scaleLabel(value: string): string {
  return `${Math.round(boundedClockScale(Number(value)) * 100)}%`;
}

function WeatherPanel({ value, language, onUpdate, operations, currentWeather }: { value: WidgetSettings['weather']; language: NewPicTabSettings['interfaceLanguage']; onUpdate: SettingsUpdater; operations: WeatherOperations; currentWeather?: WeatherSnapshot | null }) {
  const [query, setQuery] = useState(value.mode === 'city' ? value.city : '');
  const [cities, setCities] = useState<CityResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const skipNextSearch = useRef(false);
  const updateWeather = (patch: Partial<WidgetSettings['weather']>) => void onUpdate((current) => ({ ...current, widgets: { ...current.widgets, weather: { ...current.widgets.weather, ...patch } } }));

  const search = async (searchQuery = query) => {
    const normalized = searchQuery.trim();
    if (normalized.length < 2) { setMessage('请输入至少两个字符。'); return; }
    setBusy(true); setMessage(''); setCities([]);
    try {
      if (!await operations.requestAccess()) { setMessage('未授予天气服务访问权限。'); return; }
      const results = await operations.searchCities(normalized, language);
      setCities(results); if (!results.length) setMessage('没有找到匹配的城市。');
    } catch { setMessage('暂时无法搜索城市。'); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (skipNextSearch.current) { skipNextSearch.current = false; return; }
    const normalized = query.trim();
    if (normalized.length < 2) { setCities([]); setMessage(''); return; }
    const timer = window.setTimeout(() => void search(normalized), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const chooseCity = (city: CityResult) => {
    skipNextSearch.current = true;
    setQuery(city.label); setCities([]); setMessage('已选择城市。');
    updateWeather({ enabled: true, mode: 'city', city: city.label, latitude: city.latitude, longitude: city.longitude });
  };

  const useLocation = async () => {
    setBusy(true); setMessage('');
    try {
      // Both browser APIs are invoked from this click stack. No location call happens on load.
      const accessPromise = operations.requestAccess();
      const positionPromise = operations.getPosition();
      const [access, position] = await Promise.all([accessPromise, positionPromise]);
      if (!access) { setMessage('未授予天气服务访问权限。'); return; }
      if (!validCoordinates(position.latitude, position.longitude)) { setMessage('未能读取位置，请改用城市。'); return; }
      const location = await operations.reverseGeocode(position.latitude, position.longitude, language).catch(() => language === 'zh-CN' ? '当前位置' : 'Current location');
      updateWeather({ enabled: true, mode: 'coordinates', city: location, latitude: position.latitude, longitude: position.longitude });
      const response = await operations.getCurrent({ location, ...position });
      setMessage(response.ok ? '已使用当前位置。' : '位置已保存，天气稍后自动刷新。');
    } catch { setMessage('未能读取位置，请改用城市。'); }
    finally { setBusy(false); }
  };

  const setEnabled = async (enabled: boolean) => {
    if (!enabled) { updateWeather({ enabled: false }); return; }
    setMessage('');
    if (!await operations.requestAccess()) { setMessage('未授予天气服务访问权限。'); return; }
    updateWeather({ enabled: true });
  };

  return <section className="settings-section" aria-labelledby="weather-title">
    <header className="settings-section__header"><p className="settings-eyebrow">Open-Meteo</p><h2 id="weather-title">天气</h2><p>默认手动选择城市，也可主动使用浏览器定位。</p></header>
    <div className="settings-form">
      <label className="check-field"><input type="checkbox" checked={value.enabled} disabled={!value.enabled && (value.latitude === null || value.longitude === null)} onChange={(event) => void setEnabled(event.target.checked)} />显示天气</label>
      <label className="check-field"><input type="checkbox" checked={value.animated} disabled={!value.enabled} onChange={(event) => updateWeather({ animated: event.target.checked })} />轻微天气动效</label>
      {currentWeather?.stale && <p className="form-message weather-stale" role="status">当前显示的是缓存天气，网络恢复后会自动刷新。</p>}
      <div className="weather-search"><label className="field"><span>搜索城市</span><input ref={searchInput} value={query} aria-busy={busy} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }} /></label><button className="button button--secondary button--with-icon" type="button" aria-label="搜索" title="搜索" disabled={busy} onClick={() => void search()}><Icon name="search" /><span>搜索</span></button></div>
      {cities.length > 0 && <ul className="weather-results" aria-label="城市搜索结果">{cities.map((city) => <li key={city.id}><button type="button" aria-label={`选择 ${city.label}`} onClick={() => chooseCity(city)}><strong>{city.name}</strong><span>{city.label}</span></button></li>)}</ul>}
      <div className="weather-location-note"><p>定位仅在点击此按钮后读取一次，用来向 Open-Meteo 查询当地天气；NewPicTab 不会持续追踪位置。</p><div className="weather-location-action" role="group" aria-label="当前位置"><button className="button button--secondary button--with-icon" type="button" aria-label="使用当前位置" title="使用当前位置" disabled={busy} onClick={() => void useLocation()}><Icon name="location" /><span>定位</span></button>{value.mode === 'coordinates' && value.city && <span className="weather-current-location">{value.city}</span>}</div></div>
      {message && <p className="form-message" role="status" aria-live="polite">{message}</p>}
    </div>
  </section>;
}

function sendWeatherMessage(message: unknown): Promise<WeatherBackgroundResponse> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: WeatherBackgroundResponse | undefined) => {
        if (chrome.runtime.lastError || !response) resolve({ ok: false, code: 'network', message: '天气服务暂不可用。' });
        else resolve(response);
      });
    } catch { resolve({ ok: false, code: 'network', message: '天气服务暂不可用。' }); }
  });
}

function validCoordinates(latitude: number, longitude: number): boolean { return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180; }
