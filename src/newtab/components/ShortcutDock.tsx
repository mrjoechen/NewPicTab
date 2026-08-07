import { useEffect, useState, type CSSProperties } from 'react';

import type { Shortcut, ShortcutVisibleLimit } from '../../domain/types';
import { boundedShortcutDockScale, canonicalShortcutUrl, firstGrapheme, isSafeShortcutIcon, shortcutColor } from '../../domain/shortcuts';
export { canonicalShortcutUrl, firstGrapheme, isSafeShortcutIcon, MAX_SHORTCUT_ICON_BYTES, shortcutColor, validateShortcutUrl } from '../../domain/shortcuts';

export interface ShortcutDockProps {
  enabled: boolean;
  shortcuts: readonly Shortcut[];
  maxVisible?: ShortcutVisibleLimit;
  scale?: number;
}

export function ShortcutDock({ enabled, shortcuts, maxVisible = 6, scale = 1 }: ShortcutDockProps) {
  const safeShortcuts = shortcuts.flatMap((shortcut) => {
    const url = canonicalShortcutUrl(shortcut.url);
    return url ? [{ shortcut, url }] : [];
  }).slice(0, maxVisible);
  if (!enabled || safeShortcuts.length === 0) return null;

  return <nav className="shortcut-dock" aria-label="快捷网址" style={shortcutDockScaleStyle(scale)}>
    {safeShortcuts.map(({ shortcut, url }) => <a
      key={shortcut.id}
      className="shortcut-dock__item"
      href={url}
      aria-label={`打开 ${shortcut.title}`}
      title={shortcut.title}
    >
      <ShortcutTile shortcut={shortcut} />
    </a>)}
  </nav>;
}

export function shortcutDockScaleStyle(value: number): CSSProperties {
  const scale = boundedShortcutDockScale(value);
  return {
    '--shortcut-dock-padding': `${Math.round(8 * scale)}px`,
    '--shortcut-dock-gap': `${Math.round(6 * scale)}px`,
    '--shortcut-dock-radius': `${Math.round(16 * scale)}px`,
    '--shortcut-item-size': `${Math.round(44 * scale)}px`,
    '--shortcut-item-radius': `${Math.round(11 * scale)}px`,
    '--shortcut-icon-size': `${Math.round(36 * scale)}px`,
    '--shortcut-icon-radius': `${Math.round(9 * scale)}px`,
    '--shortcut-initial-size': `${Math.round(18 * scale)}px`
  } as CSSProperties;
}

function ShortcutTile({ shortcut }: { shortcut: Shortcut }) {
  const [iconFailed, setIconFailed] = useState(false);
  const icon = isSafeShortcutIcon(shortcut.customIcon) ? shortcut.customIcon : defaultFaviconUrl(shortcut.url);
  useEffect(() => { setIconFailed(false); }, [icon]);
  return icon && !iconFailed
    ? <img src={icon} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setIconFailed(true)} />
    : <span aria-hidden="true" style={{ backgroundColor: shortcutColor(shortcut.id) }}>{firstGrapheme(shortcut.title)}</span>;
}

export function defaultFaviconUrl(pageUrl: string): string | undefined {
  const canonical = canonicalShortcutUrl(pageUrl);
  if (!canonical) return undefined;
  const query = new URLSearchParams({ pageUrl: canonical, size: '64' });
  try {
    const extensionUrl = chrome.runtime.getURL(`_favicon/?${query}`);
    if (extensionUrl) return extensionUrl;
  } catch {
    // Local browser preview cannot use Chrome's extension favicon endpoint.
  }
  const host = new URL(canonical).hostname;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}
