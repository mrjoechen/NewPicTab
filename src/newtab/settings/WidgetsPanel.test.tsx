import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultSettings } from '../../domain/defaults';
import { WidgetsPanel, type WeatherOperations } from './WidgetsPanel';

afterEach(cleanup);

function operations(overrides: Partial<WeatherOperations> = {}): WeatherOperations {
  return {
    requestAccess: vi.fn(async () => true),
    searchCities: vi.fn(async () => []),
    reverseGeocode: vi.fn(async () => '当前位置'),
    getCurrent: vi.fn(async () => ({ ok: false as const, code: 'network' as const, message: '离线' })),
    getPosition: vi.fn(async () => ({ latitude: 31.2, longitude: 121.4 })),
    ...overrides
  };
}

describe('WidgetsPanel', () => {
  it('edits search visibility and engine independently against the latest settings', async () => {
    const user = userEvent.setup();
    const updaters: Array<(value: ReturnType<typeof createDefaultSettings>) => ReturnType<typeof createDefaultSettings>> = [];
    render(<WidgetsPanel section="search" settings={createDefaultSettings()} onUpdate={vi.fn((updater) => { updaters.push(updater); })} operations={operations()} />);
    await user.click(screen.getByRole('checkbox', { name: '显示搜索' }));
    await user.selectOptions(screen.getByLabelText('搜索引擎'), 'duckduckgo');
    let next = createDefaultSettings();
    next.widgets.shortcuts.enabled = true;
    for (const updater of updaters) next = updater(next);
    expect(next.widgets.search).toEqual({ enabled: true, engine: 'duckduckgo' });
    expect(next.widgets.shortcuts.enabled).toBe(true);
  });

  it('validates a custom search template before persisting it', async () => {
    const user = userEvent.setup(); const onUpdate = vi.fn();
    render(<WidgetsPanel section="search" settings={createDefaultSettings()} onUpdate={onUpdate} operations={operations()} />);
    await user.selectOptions(screen.getByLabelText('搜索引擎'), 'custom');
    fireEvent.change(screen.getByLabelText('搜索模板'), { target: { value: 'http://search.example/?q={query}' } });
    await user.click(screen.getByRole('button', { name: '保存搜索模板' }));
    expect(screen.getByRole('alert')).toHaveTextContent('模板必须使用 HTTPS。');
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('reports a rejected search settings write without an unhandled rejection', async () => {
    const user = userEvent.setup();
    render(<WidgetsPanel section="search" settings={createDefaultSettings()} onUpdate={vi.fn(async () => { throw new Error('quota'); })} operations={operations()} />);
    await user.click(screen.getByRole('checkbox', { name: '显示搜索' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('无法保存搜索设置。');
  });

  it('edits clock and date independently through updater functions', async () => {
    const user = userEvent.setup(); const updaters: Array<(value: ReturnType<typeof createDefaultSettings>) => ReturnType<typeof createDefaultSettings>> = [];
    render(<WidgetsPanel section="time" settings={createDefaultSettings()} onUpdate={vi.fn((updater) => { updaters.push(updater); })} operations={operations()} />);
    await user.click(screen.getByRole('checkbox', { name: '显示时间' }));
    await user.click(screen.getByRole('checkbox', { name: '显示农历' }));
    await user.click(screen.getByRole('checkbox', { name: '显示日期' }));
    await user.click(screen.getByRole('checkbox', { name: '显示秒数' }));
    const size = screen.getByLabelText('文字大小');
    expect(size).toHaveAttribute('type', 'range');
    expect(size).toHaveAttribute('step', '0.01');
    expect(size).toHaveAttribute('min', '0.45');
    expect(size).toHaveAttribute('max', '1.35');
    fireEvent.change(size, { target: { value: '1.35' } });
    expect(screen.getByText('135%')).toBeInTheDocument();
    fireEvent.pointerUp(size);
    await user.selectOptions(screen.getByLabelText('显示位置'), 'top-left');
    let next = createDefaultSettings(); for (const updater of updaters) next = updater(next);
    expect(next.widgets.clock).toMatchObject({ enabled: false, showSeconds: true, size: 'large', scale: 1.35, position: 'top-left' });
    expect(next.widgets.date).toMatchObject({ enabled: false, showLunar: true });
  });

  it('keeps clock size dragging local until the range interaction commits', () => {
    const onUpdate = vi.fn();
    const onPreview = vi.fn();
    render(<WidgetsPanel section="time" settings={createDefaultSettings()} onUpdate={onUpdate} operations={operations()} onClockScalePreview={onPreview} />);
    const size = screen.getByLabelText('文字大小');

    fireEvent.change(size, { target: { value: '0.45' } });

    expect(screen.getByText('45%')).toBeInTheDocument();
    expect(size).not.toBeDisabled();
    expect(onPreview).toHaveBeenLastCalledWith(0.45);
    expect(onUpdate).not.toHaveBeenCalled();

    fireEvent.pointerUp(size);
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate.mock.calls[0]![0](createDefaultSettings()).widgets.clock).toMatchObject({ size: 'compact', scale: 0.45 });
  });

  it('searches cities automatically as the user types, then saves a selected city', async () => {
    const user = userEvent.setup();
    const city = { id: 1, name: '上海', label: '上海，中国', latitude: 31.23, longitude: 121.47 };
    const searchCities = vi.fn().mockResolvedValueOnce([city]).mockResolvedValueOnce([]);
    const ops = operations({ searchCities });
    const updaters: Array<(value: ReturnType<typeof createDefaultSettings>) => ReturnType<typeof createDefaultSettings>> = [];
    render(<WidgetsPanel section="weather" settings={createDefaultSettings()} onUpdate={vi.fn((updater) => { updaters.push(updater); })} operations={ops} />);

    await user.type(screen.getByLabelText('搜索城市'), '上海');

    expect(await screen.findByRole('button', { name: '选择 上海，中国' })).toBeInTheDocument();
    expect(screen.getByLabelText('搜索城市')).toHaveFocus();
    expect(ops.searchCities).toHaveBeenCalledWith('上海', navigator.language);
    await user.click(screen.getByRole('button', { name: '选择 上海，中国' }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(searchCities).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('已选择城市。');
    expect(screen.getByRole('status')).not.toHaveTextContent('没有找到');
    expect(ops.requestAccess).toHaveBeenCalledOnce(); expect(ops.getPosition).not.toHaveBeenCalled();
    let next = createDefaultSettings(); for (const updater of updaters) next = updater(next);
    expect(next.widgets.weather).toMatchObject({ enabled: true, mode: 'city', city: '上海，中国', latitude: 31.23, longitude: 121.47 });
  });

  it('keeps the city input enabled and focused while a live search is pending', async () => {
    let resolveSearch!: (cities: Array<{ id: number; name: string; label: string; latitude: number; longitude: number }>) => void;
    const pending = new Promise<Array<{ id: number; name: string; label: string; latitude: number; longitude: number }>>((resolve) => { resolveSearch = resolve; });
    const user = userEvent.setup();
    const ops = operations({ searchCities: vi.fn(() => pending) });
    render(<WidgetsPanel section="weather" settings={createDefaultSettings()} onUpdate={vi.fn()} operations={ops} />);
    const input = screen.getByLabelText('搜索城市');

    await user.type(input, '上海');
    await waitFor(() => expect(ops.searchCities).toHaveBeenCalled());

    expect(input).toBeEnabled();
    expect(input).toHaveFocus();
    resolveSearch([]);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('没有找到'));
  });

  it('resolves the positioned coordinates to a city name before saving weather', async () => {
    const user = userEvent.setup();
    const ops = operations({
      reverseGeocode: vi.fn(async () => '上海，中国'),
      getCurrent: vi.fn(async (location) => ({ ok: true as const, weather: { location: location.location, temperature: 22, temperatureUnit: '°C', weatherCode: 0, isDay: true, fetchedAt: 1, stale: false } }))
    });
    const updaters: Array<(value: ReturnType<typeof createDefaultSettings>) => ReturnType<typeof createDefaultSettings>> = [];
    const initial = createDefaultSettings();
    const view = render(<WidgetsPanel section="weather" settings={initial} onUpdate={vi.fn((updater) => { updaters.push(updater); })} operations={ops} />);

    await user.click(screen.getByRole('button', { name: '使用当前位置' }));

    expect(ops.reverseGeocode).toHaveBeenCalledWith(31.2, 121.4, navigator.language);
    expect(ops.getCurrent).toHaveBeenCalledWith({ location: '上海，中国', latitude: 31.2, longitude: 121.4 });
    let next = initial; for (const updater of updaters) next = updater(next);
    expect(next.widgets.weather).toMatchObject({ enabled: true, mode: 'coordinates', city: '上海，中国', latitude: 31.2, longitude: 121.4 });
    view.rerender(<WidgetsPanel section="weather" settings={next} onUpdate={vi.fn()} operations={ops} />);
    const locationRow = screen.getByRole('group', { name: '当前位置' });
    expect(locationRow).toHaveTextContent('定位上海，中国');
    expect(screen.queryByText('仅保存用于天气查询的坐标。')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '改用城市' })).not.toBeInTheDocument();
  });

  it('requests exact API origins and geolocation only from the explained location button', async () => {
    const user = userEvent.setup(); const ops = operations({ getCurrent: vi.fn(async () => ({ ok: true as const, weather: { location: '当前位置', temperature: 22, temperatureUnit: '°C', weatherCode: 0, isDay: true, fetchedAt: 1, stale: false } })) });
    const updaters: Array<(value: ReturnType<typeof createDefaultSettings>) => ReturnType<typeof createDefaultSettings>> = [];
    render(<WidgetsPanel section="weather" settings={createDefaultSettings()} onUpdate={vi.fn((updater) => { updaters.push(updater); })} operations={ops} />);
    expect(screen.getByText(/仅在点击此按钮后/)).toBeInTheDocument();
    expect(ops.requestAccess).not.toHaveBeenCalled(); expect(ops.getPosition).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '使用当前位置' }));
    expect(ops.requestAccess).toHaveBeenCalledOnce(); expect(ops.getPosition).toHaveBeenCalledOnce();
    let next = createDefaultSettings(); for (const updater of updaters) next = updater(next);
    expect(next.widgets.weather).toMatchObject({ enabled: true, mode: 'coordinates', city: '当前位置', latitude: 31.2, longitude: 121.4 });
  });

  it('handles denied location quietly', async () => {
    const user = userEvent.setup(); const ops = operations({ getPosition: vi.fn(async () => { throw Object.assign(new Error('denied'), { code: 1 }); }) });
    const settings = createDefaultSettings(); settings.widgets.weather = { enabled: true, mode: 'coordinates', city: '当前位置', latitude: 31, longitude: 121, animated: true };
    render(<WidgetsPanel section="weather" settings={settings} onUpdate={vi.fn()} operations={ops} />);
    await user.click(screen.getByRole('button', { name: '使用当前位置' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('未能读取位置'));
    expect(screen.getByRole('status')).not.toHaveTextContent('denied');
  });

  it('shows stale cache state only inside weather settings', () => {
    render(<WidgetsPanel section="weather" settings={createDefaultSettings()} onUpdate={vi.fn()} operations={operations()} currentWeather={{ location: '上海', temperature: 21, temperatureUnit: '°C', weatherCode: 2, isDay: true, fetchedAt: 1, stale: true }} />);
    expect(screen.getByRole('status')).toHaveTextContent('缓存天气');
  });

  it('re-requests exact weather access when enabling a configured location', async () => {
    const user = userEvent.setup(); const ops = operations({ requestAccess: vi.fn(async () => false) });
    const settings = createDefaultSettings(); settings.widgets.weather = { enabled: false, mode: 'city', city: '上海', latitude: 31.2, longitude: 121.4, animated: true };
    const onUpdate = vi.fn();
    render(<WidgetsPanel section="weather" settings={settings} onUpdate={onUpdate} operations={ops} />);
    await user.click(screen.getByRole('checkbox', { name: '显示天气' }));
    expect(ops.requestAccess).toHaveBeenCalledOnce();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('未授予');
  });

  it('lets a user turn off a corrupt checked setting even when coordinates are incomplete', async () => {
    const user = userEvent.setup(); const settings = createDefaultSettings();
    settings.widgets.weather = { enabled: true, mode: 'city', city: '上海', latitude: 31.2, longitude: null, animated: true };
    const updaters: Array<(value: typeof settings) => typeof settings> = [];
    render(<WidgetsPanel section="weather" settings={settings} onUpdate={vi.fn((updater) => { updaters.push(updater); })} operations={operations()} />);
    const toggle = screen.getByRole('checkbox', { name: '显示天气' });
    expect(toggle).toBeEnabled();
    await user.click(toggle);
    expect(updaters).toHaveLength(1);
    expect(updaters[0]!(settings).widgets.weather.enabled).toBe(false);
  });
});
