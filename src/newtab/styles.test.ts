import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('dynamic viewport fallbacks', () => {
  it('places a vh/vw declaration immediately before every dynamic viewport declaration', () => {
    const css = readFileSync('src/newtab/styles.css', 'utf8');
    const lines = css.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!/\b100d(vh|vw)\b/.test(lines[index]!)) continue;
      expect(lines[index - 1]?.replace('100vh', '100dvh').replace('100vw', '100dvw')).toBe(lines[index]);
    }
  });
});

describe('search and shortcut layout guardrails', () => {
  it('keeps the resting controls responsive, touchable, and reduced-motion safe', () => {
    const css = readFileSync('src/newtab/styles.css', 'utf8');
    expect(css).toMatch(/\.search-box\s*\{/);
    expect(css).toMatch(/\.search-box\s*\{[^}]*border-radius:\s*18px;/s);
    expect(css).toMatch(/\.search-box__engine\s*\{[^}]*width:\s*34px;[^}]*height:\s*34px;[^}]*border-radius:\s*999px;[^}]*background:\s*transparent;[^}]*min-width:\s*34px;[^}]*min-height:\s*34px;/s);
    expect(css).toMatch(/\.search-box__engine:hover,\s*\.search-box__engine\[aria-expanded="true"\]\s*\{[^}]*background:\s*rgb\(255 255 255 \/ 0\.16\);/s);
    expect(css).toMatch(/\.search-box__submit::before\s*\{[^}]*width:\s*34px;[^}]*height:\s*34px;[^}]*border-radius:\s*999px;[^}]*background:\s*transparent;/s);
    expect(css).toMatch(/\.search-box__submit:hover\s*\{[^}]*background:\s*transparent;/s);
    expect(css).toMatch(/\.search-box__submit:hover::before\s*\{[^}]*background:\s*rgb\(255 255 255 \/ 0\.12\);/s);
    expect(css).toMatch(/\.range-field input\[type="range"\]\s*\{[^}]*min-height:\s*32px;[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
    expect(css).toMatch(/\.clock-weather__time-separator\s*\{[^}]*margin:\s*0 0\.085em;/s);
    expect(css).toMatch(/\.clock-weather__date\s*\{[^}]*display:\s*flex;[^}]*gap:\s*0\.36em 0\.78em;/s);
    expect(css).toMatch(/\.clock-weather__time\s*\{[^}]*font-size:\s*clamp\(var\(--clock-time-min,\s*68px\),\s*var\(--clock-time-fluid,\s*11vw\),\s*var\(--clock-time-max,\s*154px\)\);/s);
    expect(css).toMatch(/\.clock-weather__date\s*\{[^}]*font-size:\s*clamp\(var\(--clock-date-min,\s*18px\),\s*var\(--clock-date-fluid,\s*2vw\),\s*var\(--clock-date-max,\s*28px\)\);/s);
    expect(css).toMatch(/\.shortcut-dock\s*\{/);
    expect(css).toMatch(/\.settings-trigger\s*\{[^}]*right:\s*max\(16px,\s*env\(safe-area-inset-right\)\);/s);
    expect(css).toMatch(/\.first-run\s*\{[^}]*position:\s*fixed;[^}]*right:\s*max\(16px,\s*env\(safe-area-inset-right\)\);[^}]*bottom:\s*max\(68px,/s);
    expect(css).toMatch(/\.first-run::after\s*\{[^}]*right:\s*17px;[^}]*clip-path:\s*polygon\(0 0,\s*100% 0,\s*50% 100%\);/s);
    expect(css).toMatch(/\.first-run__action--primary\s*\{[^}]*background:\s*#e8efeb;/s);
    expect(css).toMatch(/\.change-image-trigger\s*\{[^}]*left:\s*max\(16px,\s*env\(safe-area-inset-left\)\);/s);
    expect(css).toMatch(/\.shortcut-dock\s*\{[^}]*padding:\s*var\(--shortcut-dock-padding,\s*8px\);[^}]*gap:\s*var\(--shortcut-dock-gap,\s*6px\);/s);
    expect(css).toMatch(/\.shortcut-dock__item\s*\{[^}]*min-width:\s*var\(--shortcut-item-size,\s*44px\);[^}]*min-height:\s*var\(--shortcut-item-size,\s*44px\);/s);
    expect(css).toMatch(/\.shortcut-dock__item > span,\s*\.shortcut-dock__item > img\s*\{[^}]*width:\s*var\(--shortcut-icon-size,\s*36px\);[^}]*height:\s*var\(--shortcut-icon-size,\s*36px\);/s);
    expect(css).toMatch(/\.shortcut-dock\s*\{[^}]*overflow-x:\s*hidden;[^}]*flex-wrap:\s*nowrap;/s);
    expect(css).toMatch(/@media \(max-width:\s*643px\)[\s\S]*\.shortcut-dock__item:nth-child\(n \+ 12\)/);
    expect(css).toMatch(/@media \(max-width:\s*520px\)[\s\S]*\.shortcut-dock__item:nth-child\(n \+ 7\)/);
    expect(css).toMatch(/@media \(max-width:\s*380px\)[\s\S]*\.shortcut-dock__item:nth-child\(n \+ 5\)/);
    expect(css).toMatch(/@media \(max-width:\s*780px\)[\s\S]*\.shortcut-dock\s*\{[^}]*bottom:\s*max\(74px,/s);
    expect(css).toMatch(/@media \(max-width:\s*640px\)[\s\S]*\.search-box/);
    expect(css).toMatch(/\.clock-weather\[data-position="top-center"\]\[data-search="true"\]\s*\{[^}]*top:\s*calc\(clamp\(24px,\s*9vh,\s*92px\) \+ 82px\);/s);
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.shortcut-dock__item/);
  });
});

describe('settings drawer layout guardrails', () => {
  it('keeps the WebDAV folder picker fixed, centered, and visually modal', () => {
    const css = readFileSync('src/newtab/styles.css', 'utf8');
    expect(css).toMatch(/\.webdav-picker-backdrop\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;[^}]*place-items:\s*center;[^}]*background:\s*rgb\(3 6 8 \/ 0\.66\);/s);
  });

  it('separates full-editor previews from the test action and spans the load-more control', () => {
    const css = readFileSync('src/newtab/styles.css', 'utf8');
    expect(css).toMatch(/\.source-editor > \.source-preview\s*\{[^}]*margin-top:\s*16px;/s);
    expect(css).toMatch(/\.source-preview\s*\{[^}]*max-height:\s*320px;[^}]*overflow-y:\s*auto;[^}]*background:\s*#171d20;[^}]*scrollbar-gutter:\s*stable;/s);
    expect(css).toMatch(/\.source-preview__grid\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/s);
    expect(css).toMatch(/\.source-preview__item img\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s);
    expect(css).toMatch(/\.source-preview__more\s*\{[^}]*display:\s*flex;[^}]*margin:\s*8px auto 0;/s);
  });

  it('keeps rounded panel buttons compact with centered content', () => {
    const css = readFileSync('src/newtab/styles.css', 'utf8');
    expect(css).toMatch(/\.button\s*\{[^}]*display:\s*inline-flex;[^}]*min-height:\s*42px;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*line-height:\s*1\.2;[^}]*text-align:\s*center;/s);
    expect(css).toMatch(/\.drawer-close,\s*\.text-button\s*\{[^}]*min-height:\s*40px;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*line-height:\s*1\.2;/s);
    expect(css).toMatch(/\.shortcut-list__actions button,\s*\.shortcut-icon-preview button\s*\{[^}]*display:\s*inline-flex;[^}]*min-height:\s*40px;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s);
  });

  it('keeps settings tabs compact and widens the drawer for dense panels', () => {
    const css = readFileSync('src/newtab/styles.css', 'utf8');
    expect(css).toMatch(/\.settings-drawer\s*\{[^}]*grid-template-rows:\s*auto auto minmax\(0,\s*1fr\);[^}]*width:\s*min\(640px,\s*100vw\);/s);
    expect(css).toMatch(/\.drawer-nav button\s*\{[^}]*width:\s*44px;[^}]*min-width:\s*44px;[^}]*padding:\s*0;/s);
    expect(css).toMatch(/\.drawer-nav button\.is-active\s*\{[^}]*width:\s*auto;[^}]*padding:\s*0 12px;/s);
    expect(css).toMatch(/\.drawer-nav button span\s*\{[^}]*animation:\s*drawer-tab-label-in 210ms cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\) both;/s);
    expect(css).toMatch(/\.drawer-panel\s*\{[^}]*animation:\s*drawer-panel-in 240ms cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\) both;/s);
    expect(css).toMatch(/\.drawer-content\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
    expect(css).toMatch(/\.settings-drawer :where\(input, select, textarea\):focus-visible\s*\{[^}]*outline:\s*1px solid rgb\(255 255 255 \/ 0\.48\);[^}]*outline-offset:\s*1px;/s);
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.drawer-nav button span,[\s\S]*\.drawer-panel/);
  });
});
