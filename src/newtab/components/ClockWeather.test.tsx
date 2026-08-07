import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WidgetSettings } from '../../domain/types';
import * as backgroundTone from '../backgroundTone';
import { ClockWeather } from './ClockWeather';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const widgets = (): WidgetSettings => ({
  clock: { enabled: true, hour12: false, showSeconds: false, size: 'default', scale: 1, position: 'center' },
  date: { enabled: true, format: 'medium', locale: 'zh-CN', showLunar: false },
  weather: { enabled: false, mode: 'city', city: '', latitude: null, longitude: null, animated: true },
  search: { enabled: false, engine: 'google' }, shortcuts: { enabled: false, maxVisible: 6, scale: 1 }
});

describe('ClockWeather', () => {
  it('uses an aligned minute timeout when seconds are hidden and cleans it up', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-04T10:20:30.250'));
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const view = render(<ClockWeather settings={widgets()} locale="en-GB" />);
    expect(screen.getByTestId('clock')).toHaveTextContent('10:20');
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(29_750));
    expect(screen.getByTestId('clock')).toHaveTextContent('10:21');
    view.unmount(); expect(vi.getTimerCount()).toBe(0); expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('ticks each second, supports 12-hour format, and keeps date independently hidden', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-04T13:05:06'));
    const value = widgets(); value.clock.hour12 = true; value.clock.showSeconds = true; value.date.enabled = false;
    render(<ClockWeather settings={value} locale="en-US" />);
    expect(screen.getByTestId('clock')).toHaveTextContent(/1:05:06\s?PM/i);
    expect(screen.queryByTestId('date')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByTestId('clock')).toHaveTextContent(/1:05:07\s?PM/i);
  });

  it('renders date without a clock and disables optional motion for reduced-motion users', () => {
    const matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList));
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia });
    const value = widgets(); value.clock.enabled = false; value.weather.enabled = true;
    render(<ClockWeather settings={value} weather={{ location: '上海', temperature: 23, temperatureUnit: '°C', weatherCode: 1, isDay: true, fetchedAt: 1, stale: false }} />);
    expect(screen.queryByTestId('clock')).not.toBeInTheDocument();
    expect(screen.getByTestId('date')).toBeInTheDocument();
    expect(screen.getByTestId('weather')).toHaveAttribute('data-animated', 'false');
    expect(screen.getByTestId('weather')).toHaveTextContent('上海');
    expect(screen.getByTestId('weather')).not.toHaveTextContent('已过期');
  });

  it('separates date, lunar date, and weekday into spaced display parts', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-04T12:00:00+08:00'));
    const value = widgets(); value.clock.enabled = false; value.date.showLunar = true;
    render(<ClockWeather settings={value} locale="zh-CN" />);
    const parts = [...screen.getByTestId('date').querySelectorAll('.clock-weather__date-part')].map((part) => part.textContent);
    expect(parts).toEqual(['2026年8月4日', '六月廿二', '星期二']);
    expect(screen.getByTestId('date')).toHaveAttribute('aria-label', '2026年8月4日 六月廿二 星期二');
  });

  it('falls back to the browser locale when a saved locale is invalid', () => {
    const value = widgets(); value.date.locale = 'not a valid locale !';
    expect(() => render(<ClockWeather settings={value} locale="en-GB" />)).not.toThrow();
    expect(screen.getByTestId('date')).toBeInTheDocument();
  });

  it('refreshes immediately after time and date were both disabled for a long period', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-04T10:00:00'));
    const hidden = widgets(); hidden.clock.enabled = false; hidden.date.enabled = false;
    const view = render(<ClockWeather settings={hidden} locale="en-GB" />);
    act(() => vi.setSystemTime(new Date('2026-08-04T18:42:15')));
    const visible = widgets(); visible.date.enabled = false;
    view.rerender(<ClockWeather settings={visible} locale="en-GB" />);
    expect(screen.getByTestId('clock')).toHaveTextContent('18:42');
  });

  it('maps the restrained saved text-size preset to the widget container', () => {
    const value = widgets(); value.clock.size = 'large'; value.clock.scale = 1.25; value.clock.position = 'bottom-right'; value.shortcuts.enabled = true;
    render(<ClockWeather settings={value} />);
    const widget = screen.getByLabelText('时间与天气');
    expect(widget).toHaveAttribute('data-size', 'large');
    expect(widget).toHaveAttribute('data-position', 'bottom-right');
    expect(widget).toHaveAttribute('data-search', 'false');
    expect(widget).toHaveAttribute('data-shortcuts', 'true');
    expect(widget.style.getPropertyValue('--clock-time-min')).toBe('85px');
    expect(widget.style.getPropertyValue('--clock-time-fluid')).toBe('13.75vw');
    expect(widget.style.getPropertyValue('--clock-time-max')).toBe('193px');
  });

  it('marks top-center clock layouts when search is visible so CSS can avoid overlap', () => {
    const value = widgets(); value.clock.position = 'top-center'; value.search.enabled = true;
    render(<ClockWeather settings={value} />);
    expect(screen.getByLabelText('时间与天气')).toHaveAttribute('data-position', 'top-center');
    expect(screen.getByLabelText('时间与天气')).toHaveAttribute('data-search', 'true');
  });

  it('uses minute ticks when seconds are saved but the clock itself is hidden', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-04T10:20:30'));
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const value = widgets(); value.clock.enabled = false; value.clock.showSeconds = true;
    render(<ClockWeather settings={value} />);
    expect(screen.queryByTestId('clock')).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(screen.getByTestId('date')).toHaveAttribute('dateTime', '2026-08-04');
  });

  it('marks the clock text tone from the current background image sample', async () => {
    const detectTone = vi.spyOn(backgroundTone, 'detectClockTextTone').mockResolvedValue('dark');
    const value = widgets(); value.clock.position = 'bottom-right';
    render(<ClockWeather settings={value} backgroundImage={{ id: 'one', sourceId: 'source', url: 'blob:one' }} />);

    await waitFor(() => expect(screen.getByLabelText('时间与天气')).toHaveAttribute('data-tone', 'dark'));
    expect(detectTone).toHaveBeenCalledWith('blob:one', 'bottom-right');
  });
});
