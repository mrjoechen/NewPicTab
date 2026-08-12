import type { WidgetSettings } from './types';

export const SEARCH_ENGINES = {
  google: { label: 'Google', iconUrl: '/assets/search-engines/google.ico', template: 'https://www.google.com/search?q={query}' },
  bing: { label: 'Bing', iconUrl: '/assets/search-engines/bing.ico', template: 'https://www.bing.com/search?q={query}' },
  duckduckgo: { label: 'DuckDuckGo', iconUrl: '/assets/search-engines/duckduckgo.ico', template: 'https://duckduckgo.com/?q={query}' },
  baidu: { label: 'Baidu', iconUrl: '/assets/search-engines/baidu.ico', template: 'https://www.baidu.com/s?wd={query}' }
} as const;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ENCODED_CONTROL_CHARACTERS = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;

export function validateSearchTemplate(template: string): string | null {
  if (CONTROL_CHARACTERS.test(template) || ENCODED_CONTROL_CHARACTERS.test(template)) return '模板不能包含控制字符。';
  if (template.split('{query}').length !== 2) return '模板必须包含且只能包含一个 {query}。';
  let parsed: URL;
  try { parsed = new URL(template.replace('{query}', 'newpictab-query')); }
  catch { return '请输入有效的搜索模板。'; }
  if (parsed.protocol !== 'https:') return '模板必须使用 HTTPS。';
  if (parsed.username || parsed.password) return '模板不能包含用户名或密码。';
  const placeholderIndex = template.indexOf('{query}');
  const authorityStart = template.indexOf('//') + 2;
  const authorityEndCandidates = [template.indexOf('/', authorityStart), template.indexOf('?', authorityStart), template.indexOf('#', authorityStart)].filter((index) => index >= 0);
  const authorityEnd = authorityEndCandidates.length ? Math.min(...authorityEndCandidates) : template.length;
  if (placeholderIndex < authorityEnd) return '模板中的 {query} 不能位于网址域名中。';
  const hashIndex = template.indexOf('#', authorityStart);
  if (hashIndex >= 0 && placeholderIndex > hashIndex) return '模板中的 {query} 只能位于路径或查询参数中。';
  return null;
}

export function buildSearchUrl(settings: WidgetSettings['search'], query: string): string | null {
  const normalized = query.trim();
  if (!settings.enabled || normalized === '') return null;
  const template = settings.engine === 'custom' ? settings.customTemplate : SEARCH_ENGINES[settings.engine].template;
  if (validateSearchTemplate(template)) return null;
  try {
    const target = new URL(template.replace('{query}', encodeURIComponent(normalized)));
    if (target.protocol !== 'https:' || target.username || target.password) return null;
    return target.toString();
  } catch { return null; }
}
