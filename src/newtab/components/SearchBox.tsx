import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import type { InterfaceLanguage, WidgetSettings } from '../../domain/types';
import { buildSearchUrl, SEARCH_ENGINES } from '../../domain/search';
import { Icon } from './Icon';
export { buildSearchUrl, validateSearchTemplate } from '../../domain/search';

export interface SearchBoxProps {
  settings: WidgetSettings['search'];
  language?: InterfaceLanguage;
  navigate?: (url: string) => void;
}

export function SearchBox({ settings, language = 'zh-CN', navigate = assignLocation }: SearchBoxProps) {
  const [query, setQuery] = useState('');
  const [engine, setEngine] = useState(settings.engine);
  const [engineMenuOpen, setEngineMenuOpen] = useState(false);
  const [navigationError, setNavigationError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const composing = useRef(false);
  useEffect(() => setEngine(settings.engine), [settings.engine]);
  if (!settings.enabled) return null;
  const activeSettings: WidgetSettings['search'] = engine === 'custom'
    ? settings.engine === 'custom' ? settings : { enabled: settings.enabled, engine: settings.engine }
    : { enabled: settings.enabled, engine };
  const activeEngine = activeSettings.engine === 'custom' ? null : SEARCH_ENGINES[activeSettings.engine];

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (composing.current) return;
    const target = buildSearchUrl(activeSettings, query);
    if (!target) return;
    try { navigate(target); setNavigationError(''); }
    catch { setNavigationError('无法打开搜索结果。'); }
  };
  const guardIme = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) {
      event.preventDefault();
    }
  };
  const chooseEngine = (next: typeof engine) => {
    setEngine(next);
    setEngineMenuOpen(false);
  };

  const searchLabel = language === 'zh-CN' ? '搜索' : 'Search';
  const engineLabel = language === 'zh-CN' ? '搜索引擎' : 'Search engine';
  const submitLabel = language === 'zh-CN' ? '提交搜索' : 'Submit search';
  const customLabel = language === 'zh-CN' ? '自定义' : 'Custom';
  return <form
    ref={formRef}
    className="search-box"
    role="search"
    onSubmit={submit}
    onBlur={(event) => { if (!formRef.current?.contains(event.relatedTarget)) setEngineMenuOpen(false); }}
  >
    <label className="visually-hidden" htmlFor="pictab-search">{searchLabel}</label>
    <label className="visually-hidden" htmlFor="pictab-search-engine">{engineLabel}</label>
    <button
      id="pictab-search-engine"
      className="search-box__engine"
      type="button"
      aria-label={engineLabel}
      aria-haspopup="listbox"
      aria-expanded={engineMenuOpen}
      title={engineLabel}
      onClick={() => setEngineMenuOpen((open) => !open)}
    >
      {activeEngine ? <img src={activeEngine.iconUrl} alt="" referrerPolicy="no-referrer" /> : <Icon name="search" size={16} />}
    </button>
    {engineMenuOpen && <div className="search-box__engine-menu" role="listbox" aria-label={engineLabel}>
      {Object.entries(SEARCH_ENGINES).map(([value, meta]) => <button
        key={value}
        type="button"
        role="option"
        aria-selected={activeSettings.engine === value}
        onClick={() => chooseEngine(value as typeof engine)}
      >
        <img src={meta.iconUrl} alt="" referrerPolicy="no-referrer" />
        <span>{meta.label}</span>
      </button>)}
      {settings.engine === 'custom' && <button
        type="button"
        role="option"
        aria-selected={activeSettings.engine === 'custom'}
        onClick={() => chooseEngine('custom')}
      >
        <Icon name="search" size={16} />
        <span>{customLabel}</span>
      </button>}
    </div>}
    <input
      id="pictab-search"
      type="search"
      value={query}
      autoComplete="off"
      spellCheck={false}
      enterKeyHint="search"
      placeholder={searchLabel}
      onChange={(event) => { setQuery(event.target.value); setNavigationError(''); }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={guardIme}
    />
    <button className="search-box__submit" type="submit" aria-label={submitLabel} title={submitLabel}><Icon name="search" /></button>
    {navigationError && <span className="visually-hidden" role="alert">{navigationError}</span>}
  </form>;
}

function assignLocation(url: string): void {
  window.location.assign(url);
}
