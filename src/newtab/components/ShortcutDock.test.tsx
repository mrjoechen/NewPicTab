import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { Shortcut } from '../../domain/types';
import { defaultFaviconUrl, firstGrapheme, isSafeShortcutIcon, shortcutColor, ShortcutDock, validateShortcutUrl } from './ShortcutDock';

afterEach(cleanup);

describe('shortcut helpers', () => {
  it('uses the first visible grapheme and a stable ID-derived color', () => {
    expect(firstGrapheme('  👨‍👩‍👧‍👦 Family')).toBe('👨‍👩‍👧‍👦');
    expect(firstGrapheme('')).toBe('?');
    expect(shortcutColor('stable-id')).toBe(shortcutColor('stable-id'));
    expect(shortcutColor('stable-id')).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('accepts only complete, correctly typed, bounded local image data', () => {
    expect(isSafeShortcutIcon(pngDataUrl(64, 64))).toBe(true);
    expect(isSafeShortcutIcon(pngDataUrl(2_048, 2_048))).toBe(false);
    expect(isSafeShortcutIcon('data:image/jpeg;base64,' + pngDataUrl(64, 64).split(',')[1])).toBe(false);
    expect(isSafeShortcutIcon('data:image/png;base64,iVBORw0KGgo=')).toBe(false);
  });

  it.each([
    ['https://example.com/path', null],
    ['https://example.com/path\n', '网址不能包含控制字符。'],
    ['https://example.com/path%0Ahidden', '网址不能包含控制字符。'],
    ['http://example.com', '网址必须使用 HTTPS。'],
    ['javascript:alert(1)', '网址必须使用 HTTPS。'],
    ['data:text/html,test', '网址必须使用 HTTPS。'],
    ['https://user:pass@example.com', '网址不能包含用户名或密码。']
  ])('validates shortcut URL %s', (value, expected) => {
    expect(validateShortcutUrl(value)).toBe(expected);
  });
});

describe('ShortcutDock', () => {
  const shortcut: Shortcut = { id: 'family', title: 'Family', url: 'https://example.com/' };

  it('renders only when enabled and nonempty', () => {
    const { rerender } = render(<ShortcutDock enabled={false} shortcuts={[shortcut]} />);
    expect(screen.queryByRole('navigation', { name: '快捷网址' })).not.toBeInTheDocument();
    rerender(<ShortcutDock enabled shortcuts={[]} />);
    expect(screen.queryByRole('navigation', { name: '快捷网址' })).not.toBeInTheDocument();
    rerender(<ShortcutDock enabled shortcuts={[shortcut]} />);
    expect(screen.getByRole('navigation', { name: '快捷网址' })).toBeInTheDocument();
  });

  it('renders no more than the configured visible maximum', () => {
    const shortcuts = Array.from({ length: 10 }, (_, index) => ({ ...shortcut, id: String(index), title: `Item ${index}`, url: `https://${index}.example.com/` }));
    render(<ShortcutDock enabled shortcuts={shortcuts} maxVisible={4} />);
    expect(screen.getByRole('navigation', { name: '快捷网址' })).toHaveClass('shortcut-dock');
    expect(screen.getAllByRole('link')).toHaveLength(4);
  });

  it('applies a bounded dock scale through stable CSS variables', () => {
    const { rerender } = render(<ShortcutDock enabled shortcuts={[shortcut]} scale={1.25} />);
    const dock = screen.getByRole('navigation', { name: '快捷网址' });
    expect(dock).toHaveStyle({
      '--shortcut-dock-padding': '10px',
      '--shortcut-dock-gap': '8px',
      '--shortcut-item-size': '55px',
      '--shortcut-icon-size': '45px'
    });

    rerender(<ShortcutDock enabled shortcuts={[shortcut]} scale={99} />);
    expect(dock).toHaveStyle({
      '--shortcut-item-size': '59px',
      '--shortcut-icon-size': '49px'
    });
  });

  it('uses a safe same-tab HTTPS link and a default site favicon', () => {
    const originalGetUrl = chrome.runtime.getURL;
    try {
      chrome.runtime.getURL = ((path: string) => `chrome-extension://test-extension/${path}`) as typeof chrome.runtime.getURL;
      render(<ShortcutDock enabled shortcuts={[shortcut]} />);
      const link = screen.getByRole('link', { name: '打开 Family' });
      expect(link).toHaveAttribute('href', 'https://example.com/');
      expect(link).not.toHaveAttribute('target');
      expect(link).toHaveAttribute('title', 'Family');
      expect(document.querySelector('.shortcut-dock__item img')).toHaveAttribute('src', 'chrome-extension://test-extension/_favicon/?pageUrl=https%3A%2F%2Fexample.com%2F&size=64');
      expect(defaultFaviconUrl(shortcut.url)).toBe('chrome-extension://test-extension/_favicon/?pageUrl=https%3A%2F%2Fexample.com%2F&size=64');
    } finally {
      chrome.runtime.getURL = originalGetUrl;
    }
  });

  it('renders only a validated local data icon', () => {
    const icon = pngDataUrl(64, 64);
    const view = render(<ShortcutDock enabled shortcuts={[{ ...shortcut, customIcon: icon }]} />);
    expect(view.container.querySelector('img')).toHaveAttribute('src', icon);
  });

  it('falls back to the generated tile when persisted icon data is unreadable', () => {
    const view = render(<ShortcutDock enabled shortcuts={[{ ...shortcut, customIcon: pngDataUrl(64, 64) }]} />);
    const image = view.container.querySelector('img')!;
    fireEvent.error(image);
    expect(screen.getByText('F')).toBeInTheDocument();
  });

  it('falls back to the generated tile when a site favicon fails', () => {
    render(<ShortcutDock enabled shortcuts={[shortcut]} />);
    fireEvent.error(document.querySelector('.shortcut-dock__item img')!);
    expect(screen.getByText('F')).toBeInTheDocument();
  });
});

function pngDataUrl(width: number, height: number): string {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, width); new DataView(bytes.buffer).setUint32(20, height);
  bytes.set([0, 0, 0, 0, 0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0], 29);
  return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
}
