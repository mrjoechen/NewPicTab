import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FirstRun, FIRST_RUN_DISMISSED_KEY } from './FirstRun';

afterEach(cleanup);

describe('FirstRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chrome.storage.local.get = vi.fn(async () => ({}));
    chrome.storage.local.set = vi.fn(async () => undefined);
  });

  it('shows one compact non-modal invitation over the bundled fallback only when no source is configured', async () => {
    const openSources = vi.fn();
    const { rerender } = render(<FirstRun hasConfiguredSource={false} onOpenSources={openSources} />);

    expect(await screen.findByRole('complementary', { name: '开始使用 NewPicTab' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '暂不添加' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '添加图片源' }));
    expect(openSources).toHaveBeenCalledOnce();
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ [FIRST_RUN_DISMISSED_KEY]: true });
    expect(screen.queryByRole('complementary', { name: '开始使用 NewPicTab' })).not.toBeInTheDocument();

    rerender(<FirstRun hasConfiguredSource onOpenSources={openSources} />);
    expect(screen.queryByRole('complementary', { name: '开始使用 NewPicTab' })).not.toBeInTheDocument();
  });

  it('persists dismissal from the add action and does not nag again on a later mount', async () => {
    const user = userEvent.setup();
    const view = render(<FirstRun hasConfiguredSource={false} onOpenSources={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: '添加图片源' }));

    expect(chrome.storage.local.set).toHaveBeenCalledWith({ [FIRST_RUN_DISMISSED_KEY]: true });
    expect(screen.queryByRole('complementary', { name: '开始使用 NewPicTab' })).not.toBeInTheDocument();

    view.unmount();
    chrome.storage.local.get = vi.fn(async () => ({ [FIRST_RUN_DISMISSED_KEY]: true }));
    render(<FirstRun hasConfiguredSource={false} onOpenSources={vi.fn()} />);
    await waitFor(() => expect(chrome.storage.local.get).toHaveBeenCalled());
    expect(screen.queryByRole('complementary', { name: '开始使用 NewPicTab' })).not.toBeInTheDocument();
  });

  it('dismisses when an external settings-open request arrives', async () => {
    const view = render(<FirstRun hasConfiguredSource={false} dismissRequest={0} onOpenSources={vi.fn()} />);
    expect(await screen.findByRole('complementary', { name: '开始使用 NewPicTab' })).toBeInTheDocument();

    view.rerender(<FirstRun hasConfiguredSource={false} dismissRequest={1} onOpenSources={vi.fn()} />);

    expect(chrome.storage.local.set).toHaveBeenCalledWith({ [FIRST_RUN_DISMISSED_KEY]: true });
    expect(screen.queryByRole('complementary', { name: '开始使用 NewPicTab' })).not.toBeInTheDocument();
  });

  it('holds the shared auxiliary-data lock while persisting dismissal', async () => {
    const original = navigator.locks;
    const request = vi.fn(async (_name: string, options: LockOptions, callback: () => Promise<unknown>) => callback());
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    try {
      render(<FirstRun hasConfiguredSource={false} onOpenSources={vi.fn()} />);
      await userEvent.click(await screen.findByRole('button', { name: '添加图片源' }));
      await waitFor(() => expect(request).toHaveBeenCalledWith('newpictab-auxiliary-storage', { mode: 'shared' }, expect.any(Function)));
    } finally { Object.defineProperty(navigator, 'locks', { configurable: true, value: original }); }
  });
});
