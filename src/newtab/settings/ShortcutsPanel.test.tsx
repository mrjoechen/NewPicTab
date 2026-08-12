import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultSettings } from '../../domain/defaults';
import type { NewPicTabSettings } from '../../domain/types';
import { ShortcutsPanel, validateShortcutIcon } from './ShortcutsPanel';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function StatefulPanel({ initial = createDefaultSettings() }: { initial?: NewPicTabSettings }) {
  const [settings, setSettings] = React.useState(initial);
  return <ShortcutsPanel settings={settings} onUpdate={(updater) => {
    setSettings((current) => updater(current));
    return Promise.resolve(updater(settings));
  }} />;
}

import React from 'react';

describe('ShortcutsPanel', () => {
  it('toggles the dock and supports add, edit, reorder, and delete with latest-state merges', async () => {
    const user = userEvent.setup();
    const initial = createDefaultSettings();
    initial.shortcuts = [
      { id: 'one', title: 'One', url: 'https://one.example/' },
      { id: 'two', title: 'Two', url: 'https://two.example/' }
    ];
    render(<StatefulPanel initial={initial} />);

    await user.click(screen.getByLabelText('显示快捷网址'));
    expect(screen.getByLabelText('显示快捷网址')).toBeChecked();
    await user.click(screen.getByRole('button', { name: '下移 One' }));
    const rows = screen.getAllByTestId('shortcut-row');
    expect(rows[0]).toHaveTextContent('Two');
    expect(rows[1]).toHaveTextContent('One');
    expect(screen.getByRole('button', { name: '上移 Two' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑 One' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '编辑 One' }));
    await user.clear(screen.getByLabelText('名称'));
    await user.type(screen.getByLabelText('名称'), 'Updated');
    await user.click(screen.getByRole('button', { name: '保存快捷网址' }));
    expect(screen.getByText('Updated')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '添加快捷网址' }));
    await user.type(screen.getByLabelText('名称'), 'Docs');
    await user.type(screen.getByLabelText('网址'), 'https://docs.example/path');
    await user.click(screen.getByRole('button', { name: '保存快捷网址' }));
    expect(screen.getByText('Docs')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '删除 Two' }));
    expect(screen.queryByText('Two')).not.toBeInTheDocument();
  });

  it('keeps the editor open and shows exact validation errors', async () => {
    const user = userEvent.setup();
    render(<StatefulPanel />);
    await user.click(screen.getByRole('button', { name: '添加快捷网址' }));
    await user.type(screen.getByLabelText('名称'), 'Unsafe');
    await user.type(screen.getByLabelText('网址'), 'http://example.com');
    await user.click(screen.getByRole('button', { name: '保存快捷网址' }));
    expect(screen.getByRole('alert')).toHaveTextContent('网址必须使用 HTTPS。');
    expect(screen.getByRole('button', { name: '保存快捷网址' })).toBeInTheDocument();
  });

  it('focuses the editor, restores its trigger, and gives the form a semantic region', async () => {
    const user = userEvent.setup();
    const initial = createDefaultSettings();
    initial.shortcuts = [{ id: 'one', title: 'One', url: 'https://one.example/' }];
    render(<StatefulPanel initial={initial} />);
    const edit = screen.getByRole('button', { name: '编辑 One' });
    await user.click(edit);
    expect(screen.getByRole('region', { name: '编辑快捷网址' })).toBeInTheDocument();
    expect(screen.getByLabelText('名称')).toHaveFocus();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(edit).toHaveFocus();
  });

  it('reports a rejected visibility write', async () => {
    const user = userEvent.setup();
    render(<ShortcutsPanel settings={createDefaultSettings()} onUpdate={vi.fn(async () => { throw new Error('quota'); })} />);
    await user.click(screen.getByRole('checkbox', { name: '显示快捷网址' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('无法保存快捷网址设置。');
  });

  it('disables draft-changing controls while a save is pending', async () => {
    const user = userEvent.setup(); let resolve!: () => void;
    const settings = createDefaultSettings(); settings.shortcuts = [{ id: 'one', title: 'One', url: 'https://one.example/' }];
    render(<ShortcutsPanel settings={settings} onUpdate={vi.fn(() => new Promise<typeof settings>((done) => { resolve = () => done(settings); }))} />);
    await user.click(screen.getByRole('button', { name: '编辑 One' }));
    await user.click(screen.getByRole('button', { name: '保存快捷网址' }));
    expect(screen.getByRole('button', { name: '添加快捷网址' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '编辑 One' })).toBeDisabled();
    resolve();
    await waitFor(() => expect(screen.queryByRole('region', { name: '编辑快捷网址' })).not.toBeInTheDocument());
  });

  it('disables adding more shortcuts at the storage limit and exposes a visible maximum setting', () => {
    const settings = createDefaultSettings();
    settings.shortcuts = Array.from({ length: 24 }, (_, index) => ({ id: String(index), title: `Item ${index}`, url: `https://${index}.example.com/` }));
    render(<ShortcutsPanel settings={settings} onUpdate={vi.fn()} />);
    expect(screen.getByRole('button', { name: '添加快捷网址' })).toBeDisabled();
    expect(screen.getByLabelText('最多显示')).toBeInTheDocument();
  });

  it('keeps dock size dragging local until the range interaction commits', () => {
    const settings = createDefaultSettings();
    settings.widgets.shortcuts.scale = 1.1;
    const onUpdate = vi.fn(async (updater: (current: NewPicTabSettings) => NewPicTabSettings) => updater(settings));
    render(<ShortcutsPanel settings={settings} onUpdate={onUpdate} />);

    const size = screen.getByLabelText('Dock 大小');
    expect(size).toHaveAttribute('type', 'range');
    expect(size).toHaveValue('1.1');
    expect(screen.getByText('110%')).toBeInTheDocument();

    fireEvent.change(size, { target: { value: '0.85' } });

    expect(screen.getByText('85%')).toBeInTheDocument();
    expect(size).not.toBeDisabled();
    expect(onUpdate).not.toHaveBeenCalled();

    fireEvent.pointerUp(size);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]![0](settings).widgets.shortcuts.scale).toBe(0.85);
  });

  it('previews the default website icon while adding a shortcut', async () => {
    const user = userEvent.setup();
    const originalGetUrl = chrome.runtime.getURL;
    try {
      chrome.runtime.getURL = ((path: string) => `chrome-extension://test-extension/${path}`) as typeof chrome.runtime.getURL;
      render(<StatefulPanel />);
      await user.click(screen.getByRole('button', { name: '添加快捷网址' }));
      await user.type(screen.getByLabelText('网址'), 'https://docs.example/path');

      expect(screen.getByRole('img', { name: '网站图标预览' })).toHaveAttribute('src', 'chrome-extension://test-extension/_favicon/?pageUrl=https%3A%2F%2Fdocs.example%2Fpath&size=64');
    } finally {
      chrome.runtime.getURL = originalGetUrl;
    }
  });

  it('uploads and removes a bounded local icon without remote fetching', async () => {
    const user = userEvent.setup();
    render(<StatefulPanel />);
    await user.click(screen.getByRole('button', { name: '添加快捷网址' }));
    await user.type(screen.getByLabelText('名称'), 'Local icon');
    await user.type(screen.getByLabelText('网址'), 'https://local.example/');
    const icon = pngFile(64, 64);
    class TestImage {
      width = 64;
      height = 64;
      onload: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.(new Event('load'))); }
    }
    vi.stubGlobal('Image', TestImage);
    await user.upload(screen.getByLabelText('自定义图标'), icon);
    await waitFor(() => expect(screen.getByRole('button', { name: '移除图标' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '移除图标' }));
    expect(screen.queryByRole('button', { name: '移除图标' })).not.toBeInTheDocument();
  });

  it('rejects unsupported, oversized, and over-dimension icons with exact errors', async () => {
    await expect(validateShortcutIcon(new File(['x'], 'x.svg', { type: 'image/svg+xml' }))).resolves.toEqual({ ok: false, error: '图标仅支持 PNG、JPEG 或 WebP。' });
    const tooLarge = new File([new Uint8Array(128 * 1024 + 1)], 'large.png', { type: 'image/png' });
    await expect(validateShortcutIcon(tooLarge)).resolves.toEqual({ ok: false, error: '图标不能超过 128 KB。' });
    const bomb = pngFile(4_096, 4_096);
    vi.stubGlobal('Image', class { constructor() { throw new Error('must not decode'); } });
    await expect(validateShortcutIcon(bomb)).resolves.toEqual({ ok: false, error: '图标尺寸不能超过 1024 × 1024。' });
  });

  it('checks the real file signature before decoding', async () => {
    vi.stubGlobal('Image', class { width = 64; height = 64; onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_value: string) { this.onload?.(); } });
    await expect(validateShortcutIcon(new File(['not-png'], 'fake.png', { type: 'image/png' }))).resolves.toEqual({ ok: false, error: '图标文件格式与声明类型不匹配。' });
  });

  it('times out a stalled decoder and clears handlers and image data', async () => {
    vi.useFakeTimers();
    let instance!: HangingImage;
    class HangingImage {
      width = 64; height = 64; naturalWidth = 64; naturalHeight = 64;
      onload: (() => void) | null = null; onerror: (() => void) | null = null;
      sources: string[] = [];
      constructor() { instance = this; }
      set src(value: string) { this.sources.push(value); }
    }
    vi.stubGlobal('Image', HangingImage);
    const pending = validateShortcutIcon(pngFile(64, 64));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toEqual({ ok: false, error: '图标文件无法显示或读取超时。' });
    expect(instance.onload).toBeNull(); expect(instance.onerror).toBeNull(); expect(instance.sources.at(-1)).toBe('');
  });

  it('shrinks a large but safe icon and releases the decoded image', async () => {
    let instance!: LoadedImage;
    class LoadedImage {
      width = 512; height = 256; naturalWidth = 512; naturalHeight = 256;
      onload: (() => void) | null = null; onerror: (() => void) | null = null;
      sources: string[] = [];
      constructor() { instance = this; }
      set src(value: string) { this.sources.push(value); if (value) queueMicrotask(() => this.onload?.()); }
    }
    const drawImage = vi.fn();
    vi.stubGlobal('Image', LoadedImage);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const resized = pngDataUrl(128, 64);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(resized);
    await expect(validateShortcutIcon(pngFile(512, 256))).resolves.toEqual({ ok: true, dataUrl: resized });
    expect(drawImage).toHaveBeenCalled();
    expect(instance.onload).toBeNull(); expect(instance.onerror).toBeNull(); expect(instance.sources.at(-1)).toBe('');
  });
});

function pngFile(width: number, height: number): File {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  bytes.set([0, 0, 0, 0, 0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0], 29);
  return new File([bytes], 'icon.png', { type: 'image/png' });
}

function pngDataUrl(width: number, height: number): string {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, width); new DataView(bytes.buffer).setUint32(20, height);
  bytes.set([0, 0, 0, 0, 0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0], 29);
  return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
}
