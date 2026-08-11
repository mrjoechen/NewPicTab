import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import type { WidgetSettings } from '../../domain/types';
import { describeWeatherCode, type WeatherSnapshot } from '../../weather/openMeteo';
import { detectClockTextTone, type ClockTextTone } from '../backgroundTone';
import type { BackgroundImage } from '../hooks/useBackgroundRotation';

export interface ClockWeatherProps {
  settings: WidgetSettings;
  weather?: WeatherSnapshot | null;
  locale?: string;
  backgroundImage?: Pick<BackgroundImage, 'id' | 'sourceId' | 'url'> | null;
}

export function ClockWeather({ settings, weather, locale = 'zh-CN', backgroundImage }: ClockWeatherProps) {
  const [now, setNow] = useState(() => new Date());
  const [textTone, setTextTone] = useState<ClockTextTone>('light');
  const reducedMotion = useReducedMotion();
  const tickRate = settings.clock.enabled && settings.clock.showSeconds ? 'second' : 'minute';

  useEffect(() => {
    if (!settings.clock.enabled && !settings.date.enabled) return;
    setNow(new Date());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const schedule = () => {
      const current = Date.now();
      const unit = tickRate === 'second' ? 1_000 : 60_000;
      const delay = unit - (current % unit);
      timer = setTimeout(() => {
        if (!active) return;
        setNow(new Date());
        schedule();
      }, delay);
    };
    schedule();
    return () => { active = false; if (timer !== undefined) clearTimeout(timer); };
  }, [settings.clock.enabled, settings.date.enabled, tickRate]);

  useEffect(() => {
    if (!backgroundImage?.url) { setTextTone('light'); return; }
    let active = true;
    setTextTone('light');
    void detectClockTextTone(backgroundImage.url, settings.clock.position).then((tone) => {
      if (active && tone) setTextTone(tone);
    });
    return () => { active = false; };
  }, [backgroundImage?.id, backgroundImage?.sourceId, backgroundImage?.url, settings.clock.position]);

  const time = useMemo(() => safeFormat(now, locale, {
    hour: 'numeric', minute: '2-digit', ...(settings.clock.showSeconds ? { second: '2-digit' } : {}), hour12: settings.clock.hour12
  }), [locale, now, settings.clock.hour12, settings.clock.showSeconds]);
  const date = useMemo(() => formatDateParts(now, settings.date.locale || locale, settings.date.format, settings.date.showLunar), [locale, now, settings.date.format, settings.date.locale, settings.date.showLunar]);
  const condition = weather ? describeWeatherCode(weather.weatherCode, weather.isDay, locale) : undefined;
  const style = clockScaleStyle(settings.clock.scale);

  if (!settings.clock.enabled && !settings.date.enabled && !(settings.weather.enabled && weather)) return null;
  return <section className="clock-weather" aria-label={locale === 'zh-CN' ? '时间与天气' : 'Time and weather'} data-size={settings.clock.size} data-position={settings.clock.position} data-search={String(settings.search.enabled)} data-shortcuts={String(settings.shortcuts.enabled)} data-tone={textTone} style={style}>
    {settings.clock.enabled && <time className="clock-weather__time" data-testid="clock" dateTime={now.toISOString()}>{renderTimeParts(time)}</time>}
    {settings.date.enabled && <time className="clock-weather__date" data-testid="date" dateTime={dateOnly(now)} aria-label={date.join(' ')}>
      {date.map((part, index) => <span key={`${part}-${index}`} className="clock-weather__date-part">{part}</span>)}
    </time>}
    {settings.weather.enabled && weather && condition && <div className="clock-weather__weather" data-testid="weather" data-animated={String(settings.weather.animated && !reducedMotion)} aria-label={`${weather.location}，${condition.label}，${Math.round(weather.temperature)} ${weather.temperatureUnit}`}>
      <span className="clock-weather__weather-icon" aria-hidden="true">{condition.icon}</span>
      <span>{weather.location}</span>
      <span>{Math.round(weather.temperature)}{weather.temperatureUnit}</span>
      <span>{condition.label}</span>
    </div>}
  </section>;
}

type ClockScaleStyle = CSSProperties & {
  '--clock-time-min': string;
  '--clock-time-fluid': string;
  '--clock-time-max': string;
  '--clock-date-min': string;
  '--clock-date-fluid': string;
  '--clock-date-max': string;
};

function clockScaleStyle(value: number): ClockScaleStyle {
  const scale = Number.isFinite(value) ? Math.min(1.35, Math.max(0.45, value)) : 1;
  return {
    '--clock-time-min': `${Math.round(68 * scale)}px`,
    '--clock-time-fluid': `${(11 * scale).toFixed(2)}vw`,
    '--clock-time-max': `${Math.round(154 * scale)}px`,
    '--clock-date-min': `${Math.round(18 * scale)}px`,
    '--clock-date-fluid': `${(2 * scale).toFixed(2)}vw`,
    '--clock-date-max': `${Math.round(28 * scale)}px`
  };
}

function dateOnly(value: Date): string {
  const year = value.getFullYear(); const month = String(value.getMonth() + 1).padStart(2, '0'); const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function safeFormat(value: Date, locale: string, options: Intl.DateTimeFormatOptions): string {
  try { return new Intl.DateTimeFormat(locale || undefined, options).format(value); }
  catch { return new Intl.DateTimeFormat(undefined, options).format(value); }
}

function formatDateParts(value: Date, locale: string, format: WidgetSettings['date']['format'], showLunar: boolean): string[] {
  const dateOptions: Intl.DateTimeFormatOptions = format === 'full'
    ? { year: 'numeric', month: 'long', day: 'numeric' }
    : { dateStyle: format };
  return [
    safeFormat(value, locale, dateOptions),
    ...(showLunar ? [formatLunarDate(value)] : []),
    safeFormat(value, locale, { weekday: 'long' })
  ].filter(Boolean);
}

function renderTimeParts(value: string) {
  return value.split(/([:：])/).map((part, index) => {
    const separator = part === ':' || part === '：';
    return <span key={`${part}-${index}`} className={separator ? 'clock-weather__time-separator' : 'clock-weather__time-number'}>{part}</span>;
  });
}

function formatLunarDate(value: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' }).formatToParts(value);
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = Number(parts.find((part) => part.type === 'day')?.value);
    if (month && Number.isInteger(day) && day >= 1 && day <= 30) return `${month}${lunarDayName(day)}`;
    return new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' }).format(value);
  } catch {
    return '';
  }
}

function lunarDayName(day: number): string {
  const names = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十', '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];
  return names[day - 1] ?? String(day);
}

function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setReduced(media.matches);
    update(); media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  return reduced;
}
