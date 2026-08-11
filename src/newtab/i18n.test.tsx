import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LanguageProvider, localizeRuntimeMessage, useDocumentLocalization, useText } from './i18n';

function Probe() {
  const { language, text } = useText();
  return <span>{language}:{text('设置', 'Settings')}</span>;
}

function DocumentProbe({ language }: { language: 'zh-CN' | 'en-US' }) {
  useDocumentLocalization(language);
  return <section><h2>天气</h2><label>搜索城市<input aria-label="搜索城市" /></label><p className="source-card"><h3>上海相册</h3></p></section>;
}

describe('new-tab localization', () => {
  it('provides the selected interface language to nested UI', () => {
    render(<LanguageProvider language="en-US"><Probe /></LanguageProvider>);
    expect(screen.getByText('en-US:Settings')).toBeInTheDocument();
  });

  it('localizes existing and dynamic settings UI while preserving user content and switch-back', async () => {
    const view = render(<DocumentProbe language="en-US" />);
    expect(screen.getByRole('heading', { name: 'Weather' })).toBeInTheDocument();
    expect(screen.getByLabelText('Search cities')).toBeInTheDocument();
    expect(screen.getByText('上海相册')).toBeInTheDocument();

    const message = document.createElement('p'); message.textContent = '连接成功。'; document.body.append(message);
    await act(async () => { await Promise.resolve(); });
    expect(message).toHaveTextContent('Connected.');

    view.rerender(<DocumentProbe language="zh-CN" />);
    expect(screen.getByRole('heading', { name: '天气' })).toBeInTheDocument();
    expect(screen.getByLabelText('搜索城市')).toBeInTheDocument();
    message.remove();
  });

  it('translates known runtime failures without altering unknown remote content', () => {
    expect(localizeRuntimeMessage('en-US', '天气服务暂不可用。')).toBe('The weather service is unavailable.');
    expect(localizeRuntimeMessage('en-US', 'Remote-specific detail')).toBe('Remote-specific detail');
    expect(localizeRuntimeMessage('zh-CN', '天气服务暂不可用。')).toBe('天气服务暂不可用。');
  });
});
