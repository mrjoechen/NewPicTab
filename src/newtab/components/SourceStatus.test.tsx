import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SourceStatus } from './SourceStatus';

afterEach(cleanup);

describe('SourceStatus', () => {
  it.each([
    ['loading', '正在载入图片…'],
    ['ready', '连接正常。'],
    ['stale', '刷新失败，正在使用缓存。'],
    ['error', '无法载入图片，请检查配置后重试。']
  ] as const)('renders a concise settings-only %s state', (status, text) => {
    render(<SourceStatus state={{ status, message: 'private adapter text' }} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText('private adapter text')).not.toBeInTheDocument();
  });

  it('reveals and copies only bounded recursively redacted technical detail for a protected source', async () => {
    const copy = vi.fn(async (_value: string) => undefined);
    render(<SourceStatus state={{
      status: 'error',
      detail: {
        endpoint: 'https://ada:pw@dav.example.test/private/photo.jpg?token=query-private',
        headers: { Authorization: 'Basic auth-private', 'X-Api-Key': 'key-private' },
        error: new Error('Bearer message-private at https://dav.example.test/private/path?x=1')
      },
      protected: true
    }} onCopy={copy} />);

    expect(document.body.textContent).not.toContain('dav.example.test');
    await userEvent.click(screen.getByRole('button', { name: '查看技术详情' }));
    expect(screen.getByText(/URL REDACTED/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ada|pw|query-private|auth-private|key-private|message-private|dav\.example/);
    await userEvent.click(screen.getByRole('button', { name: '复制安全详情' }));
    expect(copy).toHaveBeenCalledOnce();
    expect(copy.mock.calls[0]?.[0]).not.toMatch(/query-private|auth-private|key-private|message-private|dav\.example/);
  });
});
