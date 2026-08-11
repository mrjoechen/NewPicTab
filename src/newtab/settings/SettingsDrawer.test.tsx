import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultSettings } from '../../domain/defaults';
import { isolateModalBackground } from '../../lib/modalIsolation';
import { SettingsDrawer } from './SettingsDrawer';

afterEach(cleanup);

describe('SettingsDrawer', () => {
  it('falls back to tabindex isolation without inert and restores every original value exactly', async () => {
    const inertDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'inert');
    Reflect.deleteProperty(HTMLElement.prototype, 'inert');
    const background = document.createElement('main');
    const button = document.createElement('button');
    const link = document.createElement('a'); link.href = 'https://example.test/';
    const input = document.createElement('input');
    const positive = document.createElement('button'); positive.setAttribute('tabindex', '2');
    const negative = document.createElement('button'); negative.setAttribute('tabindex', '-1');
    background.append(button, link, input, positive, negative); document.body.append(background);
    try {
      render(<SettingsDrawer settings={createDefaultSettings()} backgroundElement={background} onUpdate={vi.fn()} onChangeImage={vi.fn()} />);
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: '打开设置' }));

      for (const element of [button, link, input, positive, negative]) expect(element).toHaveAttribute('tabindex', '-1');
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
      expect(screen.getByRole('button', { name: '添加图片源' })).toHaveFocus();
      expect([button, link, input, positive, negative]).not.toContain(document.activeElement);

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(button).not.toHaveAttribute('tabindex'); expect(link).not.toHaveAttribute('tabindex'); expect(input).not.toHaveAttribute('tabindex');
      expect(positive).toHaveAttribute('tabindex', '2'); expect(negative).toHaveAttribute('tabindex', '-1');
    } finally {
      cleanup(); background.remove();
      if (inertDescriptor) Object.defineProperty(HTMLElement.prototype, 'inert', inertDescriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, 'inert');
    }
  });

  it('continuously isolates dynamic focusables and redirects programmatic focus without inert', async () => {
    const inertDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'inert');
    Reflect.deleteProperty(HTMLElement.prototype, 'inert');
    const background = document.createElement('main'); document.body.append(background);
    try {
      render(<SettingsDrawer settings={createDefaultSettings()} backgroundElement={background} onUpdate={vi.fn()} onChangeImage={vi.fn()} />);
      const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: '打开设置' }));
      const close = screen.getByRole('button', { name: '关闭设置' });
      const button = document.createElement('button');
      const link = document.createElement('a');
      const input = document.createElement('input'); input.disabled = true;
      const promoted = document.createElement('div');
      background.append(button, link, input, promoted);
      await waitFor(() => expect(button).toHaveAttribute('tabindex', '-1'));
      expect(link).not.toHaveAttribute('tabindex'); expect(input).not.toHaveAttribute('tabindex'); expect(promoted).not.toHaveAttribute('tabindex');
      link.href = 'https://dynamic.example/'; input.disabled = false; promoted.setAttribute('tabindex', '2');

      await waitFor(() => {
        expect(button).toHaveAttribute('tabindex', '-1'); expect(link).toHaveAttribute('tabindex', '-1');
        expect(input).toHaveAttribute('tabindex', '-1'); expect(promoted).toHaveAttribute('tabindex', '-1');
      });
      button.focus();
      expect(close).toHaveFocus();

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(button).not.toHaveAttribute('tabindex'); expect(link).not.toHaveAttribute('tabindex'); expect(input).not.toHaveAttribute('tabindex');
      expect(promoted).toHaveAttribute('tabindex', '2');
    } finally {
      cleanup(); background.remove();
      if (inertDescriptor) Object.defineProperty(HTMLElement.prototype, 'inert', inertDescriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, 'inert');
    }
  });

  it('keeps dynamic fallback isolation until the last nested owner releases it', async () => {
    const background = document.createElement('main'); const firstTarget = document.createElement('button'); const secondTarget = document.createElement('button');
    document.body.append(background, firstTarget, secondTarget);
    const releaseFirst = isolateModalBackground(background, () => firstTarget);
    const releaseSecond = isolateModalBackground(background, () => secondTarget);
    const dynamic = document.createElement('a'); dynamic.href = 'https://nested.example/'; dynamic.setAttribute('tabindex', '2'); background.append(dynamic);
    await waitFor(() => expect(dynamic).toHaveAttribute('tabindex', '-1'));

    releaseFirst(); dynamic.focus();
    expect(dynamic).toHaveAttribute('tabindex', '-1'); expect(secondTarget).toHaveFocus();
    releaseSecond();
    expect(dynamic).toHaveAttribute('tabindex', '2'); expect(background).not.toHaveAttribute('aria-hidden');
    background.remove(); firstTarget.remove(); secondTarget.remove();
  });

  it('leaves no fallback tabindex residue after StrictMode effect replay and unmount', async () => {
    const background = document.createElement('main');
    const button = document.createElement('button');
    const ordered = document.createElement('a'); ordered.href = 'https://example.test/'; ordered.setAttribute('tabindex', '2');
    background.append(button, ordered); document.body.append(background);
    const view = render(<StrictMode><SettingsDrawer settings={createDefaultSettings()} backgroundElement={background} onUpdate={vi.fn()} onChangeImage={vi.fn()} /></StrictMode>);
    await userEvent.setup().click(screen.getByRole('button', { name: '打开设置' }));
    expect(button).toHaveAttribute('tabindex', '-1'); expect(ordered).toHaveAttribute('tabindex', '-1');

    view.unmount();
    expect(button).not.toHaveAttribute('tabindex'); expect(ordered).toHaveAttribute('tabindex', '2');
    expect(background).not.toHaveAttribute('aria-hidden');
    background.remove();
  });

  it('opens as a modal, traps focus, closes with Escape, and restores focus', async () => {
    const user = userEvent.setup();
    const background = document.createElement('main');
    const onOpen = vi.fn();
    document.body.append(background);
    render(
      <SettingsDrawer
        settings={createDefaultSettings()}
        backgroundElement={background}
        onUpdate={vi.fn()}
        onChangeImage={vi.fn()}
        onOpen={onOpen}
      />
    );

    const trigger = screen.getByRole('button', { name: '打开设置' });
    await user.click(trigger);

    expect(onOpen).toHaveBeenCalledOnce();
    expect(screen.getByRole('dialog', { name: '设置' })).toBeInTheDocument();
    expect(background).toHaveAttribute('aria-hidden', 'true');
    expect(background.inert).toBe(true);
    expect(screen.getByRole('button', { name: '关闭设置' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: '添加图片源' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(background).not.toHaveAttribute('aria-hidden');
    expect(background.inert).toBe(false);
    expect(trigger).toHaveFocus();
  });

  it('offers complete navigation and real weather controls', async () => {
    const user = userEvent.setup();
    render(
      <SettingsDrawer
        settings={createDefaultSettings()}
        onUpdate={vi.fn()}
        onChangeImage={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: '打开设置' }));

    for (const name of ['图片源', '动效', '时间和日期', '天气', '搜索', '快捷网址', '关于']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }

    const navigation = screen.getByRole('navigation', { name: '设置页面' });
    expect(within(navigation).getByText('图片源')).toBeInTheDocument();
    expect(within(navigation).queryByText('天气')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '天气' }));
    expect(screen.getByRole('heading', { name: '天气' })).toBeInTheDocument();
    expect(within(navigation).getByText('天气')).toBeInTheDocument();
    expect(within(navigation).queryByText('图片源')).not.toBeInTheDocument();
    expect(screen.getByLabelText('搜索城市')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '使用当前位置' })).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();

    await user.click(within(navigation).getByRole('button', { name: '搜索' }));
    expect(screen.getByRole('heading', { name: '搜索' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '显示搜索' })).toBeInTheDocument();

    await user.click(within(navigation).getByRole('button', { name: '快捷网址' }));
    expect(screen.getByRole('heading', { name: '快捷网址' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加快捷网址' })).toBeInTheDocument();

    await user.click(within(navigation).getByRole('button', { name: '关于' }));
    expect(screen.getByRole('heading', { name: '关于与隐私' })).toBeInTheDocument();
  });

  it('fully localizes settings content after switching to English', async () => {
    const settings = createDefaultSettings(); settings.interfaceLanguage = 'en-US';
    render(<SettingsDrawer settings={settings} onUpdate={vi.fn()} onChangeImage={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open settings' }));

    expect(screen.getByRole('heading', { name: 'Sources' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Effect' }).querySelector('path')).toHaveAttribute('d', 'm4 20 11-11');
    expect(screen.getByRole('button', { name: 'Time and Date' })).toBeInTheDocument();
    expect(screen.getByText('No image sources yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add image source' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Weather' }));
    expect(screen.getByRole('heading', { name: 'Weather' })).toBeInTheDocument();
    expect(screen.getByLabelText('Search cities')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use current location' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'About' }));
    expect(screen.getByRole('heading', { name: 'About and privacy' })).toBeInTheDocument();
    expect(screen.getByText(/contains no analytics, telemetry, or tracking/)).toBeInTheDocument();
    expect(screen.getByText(/TMDB content and trademarks belong/)).toBeInTheDocument();
    expect(document.querySelector('.settings-drawer')?.textContent).not.toMatch(/[㐀-鿿]/);
  });

  it('opens directly on Sources when the first-run request changes', async () => {
    const view = render(<SettingsDrawer settings={createDefaultSettings()} openSourcesRequest={0} onUpdate={vi.fn()} onChangeImage={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    view.rerender(<SettingsDrawer settings={createDefaultSettings()} openSourcesRequest={1} onUpdate={vi.fn()} onChangeImage={vi.fn()} />);

    expect(await screen.findByRole('dialog', { name: '设置' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '图片源' })).toBeInTheDocument();
  });

  it('persists the interface language from the settings header', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(<SettingsDrawer settings={createDefaultSettings()} onUpdate={onUpdate} onChangeImage={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '打开设置' }));
    expect(screen.queryByRole('combobox', { name: '界面语言' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '界面语言' }));
    const next = onUpdate.mock.calls[0]![0](createDefaultSettings());
    expect(next.interfaceLanguage).toBe('en-US');
  });

  it('lets Escape close the shortcut editor without closing the settings drawer', async () => {
    const user = userEvent.setup();
    render(<SettingsDrawer settings={createDefaultSettings()} onUpdate={vi.fn()} onChangeImage={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '打开设置' }));
    await user.click(screen.getByRole('button', { name: '快捷网址' }));
    await user.click(screen.getByRole('button', { name: '添加快捷网址' }));

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('region', { name: '添加快捷网址' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '设置' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加快捷网址' })).toHaveFocus();
  });

  it('lets Escape close the shortcut editor when focus moved elsewhere in the drawer', async () => {
    const user = userEvent.setup();
    render(<SettingsDrawer settings={createDefaultSettings()} onUpdate={vi.fn()} onChangeImage={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '打开设置' }));
    await user.click(screen.getByRole('button', { name: '快捷网址' }));
    await user.click(screen.getByRole('button', { name: '添加快捷网址' }));
    await user.tab({ shift: true });
    expect(screen.getByLabelText('Dock 大小')).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('region', { name: '添加快捷网址' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '设置' })).toBeInTheDocument();
  });

  it('does not let Escape close the drawer while the shortcut editor is busy', async () => {
    const user = userEvent.setup();
    const pending = new Promise<ReturnType<typeof createDefaultSettings>>(() => undefined);
    render(<SettingsDrawer settings={createDefaultSettings()} onUpdate={vi.fn(() => pending)} onChangeImage={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '打开设置' }));
    await user.click(screen.getByRole('button', { name: '快捷网址' }));
    await user.click(screen.getByRole('button', { name: '添加快捷网址' }));
    await user.type(screen.getByLabelText('名称'), 'Docs');
    await user.type(screen.getByLabelText('网址'), 'https://docs.example/');
    await user.click(screen.getByRole('button', { name: '保存快捷网址' }));

    await user.keyboard('{Escape}');

    expect(screen.getByRole('region', { name: '添加快捷网址' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '设置' })).toBeInTheDocument();
  });

  it('emits appearance patches that merge against the latest locked settings value', async () => {
    const user = userEvent.setup(); const updaters: Array<(current: ReturnType<typeof createDefaultSettings>) => ReturnType<typeof createDefaultSettings>> = [];
    render(<SettingsDrawer settings={createDefaultSettings()} onUpdate={vi.fn((updater) => { updaters.push(updater); })} onChangeImage={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '打开设置' })); await user.click(screen.getByRole('button', { name: '动效' }));
    await user.selectOptions(screen.getByLabelText('切换样式'), 'slide'); await user.selectOptions(screen.getByLabelText('换图时机'), 'interval');
    let current = createDefaultSettings(); for (const updater of updaters) current = updater(current);
    expect(current.appearance).toMatchObject({ transition: 'slide', changeOn: 'interval' });
  });

  it('lets Escape close only a nested delete confirmation before the drawer', async () => {
    const user = userEvent.setup();
    const source = { id: 'one', name: 'One', type: 'direct' as const, enabled: true, createdAt: 1, updatedAt: 1, entries: [{ id: 'a', url: 'https://images.example/a.jpg' }] };
    render(<SettingsDrawer settings={{ ...createDefaultSettings(), sources: [source] }} onUpdate={vi.fn()} onChangeImage={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '打开设置' }));
    const close = screen.getByRole('button', { name: '关闭设置' });
    const appearance = screen.getByRole('button', { name: '动效' });
    const deleteTrigger = screen.getByRole('button', { name: '删除 One' });
    deleteTrigger.setAttribute('tabindex', '2'); appearance.setAttribute('tabindex', '-1');
    await user.click(screen.getByRole('button', { name: '删除 One' }));
    const isolatedDrawer = document.querySelector<HTMLElement>('.settings-drawer')!;
    expect(isolatedDrawer).toHaveAttribute('aria-hidden', 'true');
    expect(isolatedDrawer.inert).toBe(true);
    expect(close).toHaveAttribute('tabindex', '-1'); expect(appearance).toHaveAttribute('tabindex', '-1'); expect(deleteTrigger).toHaveAttribute('tabindex', '-1');
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '设置' })).toBeInTheDocument();
    expect(close).not.toHaveAttribute('tabindex'); expect(appearance).toHaveAttribute('tabindex', '-1'); expect(deleteTrigger).toHaveAttribute('tabindex', '2');
  });
});
