import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WidgetSettings } from '../../domain/types';
import { buildSearchUrl, SearchBox, validateSearchTemplate } from './SearchBox';

afterEach(cleanup);

describe('search helpers', () => {
  it.each([
    ['google', 'https://www.google.com/search?q=%E7%8C%AB%20%26%20%E7%8B%97'],
    ['bing', 'https://www.bing.com/search?q=%E7%8C%AB%20%26%20%E7%8B%97'],
    ['duckduckgo', 'https://duckduckgo.com/?q=%E7%8C%AB%20%26%20%E7%8B%97'],
    ['baidu', 'https://www.baidu.com/s?wd=%E7%8C%AB%20%26%20%E7%8B%97']
  ] as const)('builds a safe %s URL', (engine, expected) => {
    expect(buildSearchUrl({ enabled: true, engine }, '  猫 & 狗  ')).toBe(expected);
  });

  it('requires exactly one literal placeholder in a credential-free HTTPS template', () => {
    expect(validateSearchTemplate('https://search.example/find?q={query}')).toBeNull();
    expect(validateSearchTemplate('https://search.example/find')).toBe('模板必须包含且只能包含一个 {query}。');
    expect(validateSearchTemplate('https://search.example/{query}?q={query}')).toBe('模板必须包含且只能包含一个 {query}。');
    expect(validateSearchTemplate('https://search.example/find?q=%7Bquery%7D')).toBe('模板必须包含且只能包含一个 {query}。');
    expect(validateSearchTemplate('http://search.example/?q={query}')).toBe('模板必须使用 HTTPS。');
    expect(validateSearchTemplate('https://user:secret@search.example/?q={query}')).toBe('模板不能包含用户名或密码。');
    expect(validateSearchTemplate('https://search.example/?q={query}\n')).toBe('模板不能包含控制字符。');
    expect(validateSearchTemplate('https://search.example/?q={query}&next=%0Aevil')).toBe('模板不能包含控制字符。');
    expect(validateSearchTemplate('https://{query}.search.example/')).toBe('模板中的 {query} 不能位于网址域名中。');
    expect(validateSearchTemplate('https://search.example/#find-{query}')).toBe('模板中的 {query} 只能位于路径或查询参数中。');
  });

  it('replaces the custom placeholder exactly once after validation', () => {
    expect(buildSearchUrl({ enabled: true, engine: 'custom', customTemplate: 'https://search.example/find?q={query}&from=newpictab' }, 'a/b'))
      .toBe('https://search.example/find?q=a%2Fb&from=newpictab');
  });
});

describe('SearchBox', () => {
  const search = (engine: WidgetSettings['search'] = { enabled: true, engine: 'google' }) => engine;

  it('renders only when enabled and never navigates for whitespace', async () => {
    const navigate = vi.fn();
    const { rerender } = render(<SearchBox settings={search({ enabled: false, engine: 'google' })} navigate={navigate} />);
    expect(screen.queryByRole('search')).not.toBeInTheDocument();
    rerender(<SearchBox settings={search()} navigate={navigate} />);
    await userEvent.setup().type(screen.getByRole('searchbox', { name: '搜索' }), '   {Enter}');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('submits trimmed encoded text through the injected location adapter', async () => {
    const navigate = vi.fn();
    render(<SearchBox settings={search({ enabled: true, engine: 'bing' })} navigate={navigate} />);
    await userEvent.setup().type(screen.getByRole('searchbox', { name: '搜索' }), '  quiet photo  {Enter}');
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('https://www.bing.com/search?q=quiet%20photo');
  });

  it('lets the tab page switch between built-in search engines from the search box', async () => {
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<SearchBox settings={search({ enabled: true, engine: 'google' })} navigate={navigate} />);
    await user.click(screen.getByRole('button', { name: '搜索引擎' }));
    await user.click(screen.getByRole('option', { name: 'Baidu' }));
    await user.type(screen.getByRole('searchbox', { name: '搜索' }), 'photo{Enter}');
    expect(navigate).toHaveBeenCalledWith('https://www.baidu.com/s?wd=photo');
  });

  it('uses the bundled selected search engine icon instead of a remote favicon', () => {
    render(<SearchBox settings={search({ enabled: true, engine: 'duckduckgo' })} />);
    expect(screen.getByRole('search').querySelector('.search-box__engine img')).toHaveAttribute('src', '/assets/search-engines/duckduckgo.ico');
  });

  it('does not submit while an IME composition is active and has an accessible submit button', () => {
    const navigate = vi.fn();
    render(<SearchBox settings={search()} navigate={navigate} />);
    const input = screen.getByRole('searchbox', { name: '搜索' });
    fireEvent.change(input, { target: { value: '图片' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '提交搜索' })).toBeInTheDocument();
  });

  it('contains an unexpected navigation adapter failure', async () => {
    const navigate = vi.fn(() => { throw new Error('navigation failed'); });
    render(<SearchBox settings={search()} navigate={navigate} />);
    await userEvent.setup().type(screen.getByRole('searchbox', { name: '搜索' }), 'photo');
    expect(() => fireEvent.submit(screen.getByRole('search'))).not.toThrow();
    expect(screen.getByRole('alert')).toHaveTextContent('无法打开搜索结果。');
  });
});
