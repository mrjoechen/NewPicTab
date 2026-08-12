import { useEffect, useRef, useState } from 'react';

import type { InterfaceLanguage, NewPicTabSettings } from '../../domain/types';
import { AppearancePanel } from './AppearancePanel';
import { SourcesPanel, type SettingsUpdater, type SourceLoadState, type SourceOperations } from './SourcesPanel';
import { isolateModalBackground } from '../../lib/modalIsolation';
import { PROJECT_DONATION_URL, PROJECT_REPOSITORY_URL } from '../../project';
import { WidgetsPanel } from './WidgetsPanel';
import type { WeatherSnapshot } from '../../weather/openMeteo';
import { ShortcutsPanel } from './ShortcutsPanel';
import { AboutPanel } from './AboutPanel';
import { Icon, type IconName } from '../components/Icon';
import { LanguageProvider, useDocumentLocalization } from '../i18n';

type PanelName = 'sources' | 'appearance' | 'time' | 'weather' | 'search' | 'shortcuts' | 'about';

export interface SettingsDrawerProps {
  settings: NewPicTabSettings;
  onUpdate: SettingsUpdater;
  onChangeImage: () => void | Promise<void>;
  operations?: SourceOperations;
  sourceCounts?: Record<string, number | undefined>;
  sourceStates?: Record<string, SourceLoadState | undefined>;
  onRefreshSource?: (sourceId: string) => void | Promise<void>;
  backgroundElement?: HTMLElement | null;
  weather?: WeatherSnapshot | null;
  openSourcesRequest?: number;
  onOpen?: () => void;
  onClockScalePreview?: (scale: number | null) => void;
  onDataCleared?: (settings: NewPicTabSettings) => void;
}

const NAVIGATION: { id: PanelName; icon: IconName; label: Record<InterfaceLanguage, string> }[] = [
  { id: 'sources', icon: 'image', label: { 'zh-CN': '图片源', 'en-US': 'Sources' } },
  { id: 'appearance', icon: 'wand', label: { 'zh-CN': '动效', 'en-US': 'Effect' } },
  { id: 'time', icon: 'clock', label: { 'zh-CN': '时间和日期', 'en-US': 'Time and Date' } },
  { id: 'weather', icon: 'cloud', label: { 'zh-CN': '天气', 'en-US': 'Weather' } },
  { id: 'search', icon: 'search', label: { 'zh-CN': '搜索', 'en-US': 'Search' } },
  { id: 'shortcuts', icon: 'globe', label: { 'zh-CN': '快捷网址', 'en-US': 'Shortcuts' } },
  { id: 'about', icon: 'info', label: { 'zh-CN': '关于', 'en-US': 'About' } }
];

const EMPTY_OPERATIONS: SourceOperations = {
  test: async () => ({ ok: false, error: { code: 'unknown', message: '图片源服务暂不可用。' } }),
  importLocal: async () => ({ imported: 0, failures: [] }),
  delete: async () => undefined,
  loadTmdbMetadata: async () => ({ ok: false, error: { message: 'TMDB 服务暂不可用。' } }),
  withOriginPermissions: async () => ({ ok: false, error: { code: 'permission-denied', message: '图片源权限服务暂不可用。' } })
};

export function SettingsDrawer({ settings, onUpdate, onChangeImage, operations = EMPTY_OPERATIONS, sourceCounts = {}, sourceStates = {}, onRefreshSource = () => undefined, backgroundElement, weather, openSourcesRequest = 0, onOpen = () => undefined, onClockScalePreview, onDataCleared = () => undefined }: SettingsDrawerProps) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<PanelName>('sources');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const language = settings.interfaceLanguage;
  useDocumentLocalization(language);
  const labels = {
    title: language === 'zh-CN' ? '设置' : 'Settings',
    open: language === 'zh-CN' ? '打开设置' : 'Open settings',
    close: language === 'zh-CN' ? '关闭设置' : 'Close settings',
    language: language === 'zh-CN' ? '界面语言' : 'Interface language',
    repository: language === 'zh-CN' ? '打开 GitHub 项目' : 'Open GitHub project',
    donation: language === 'zh-CN' ? '支持作者' : 'Support the author',
    nav: language === 'zh-CN' ? '设置页面' : 'Settings pages'
  };

  useEffect(() => {
    if (openSourcesRequest <= 0) return;
    setPanel('sources');
    setOpen(true);
  }, [openSourcesRequest]);

  useEffect(() => {
    if (!open) return;
    const releaseIsolation = isolateModalBackground(backgroundElement ?? null, () => closeRef.current);
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[role="alertdialog"]')) return;
      if (event.key === 'Escape' && dialogRef.current?.querySelector('.shortcut-editor')) return;
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
      if (event.key !== 'Tab') return;
      const focusable = focusableElements(dialogRef.current);
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first!.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      releaseIsolation();
      triggerRef.current?.focus();
    };
  }, [backgroundElement, open]);

  return <LanguageProvider language={language}>
    <button ref={triggerRef} className="settings-trigger icon-button" type="button" aria-label={labels.open} title={labels.open} onClick={() => { onOpen(); setOpen(true); }}><Icon name="settings" /></button>
    {open && <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div ref={dialogRef} className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="drawer-header"><div><p className="settings-eyebrow">NewPicTab</p><h1 id="settings-title">{labels.title}</h1></div><div className="drawer-header__actions"><button ref={closeRef} className="drawer-close icon-button" type="button" aria-label={labels.close} title={labels.close} onClick={() => setOpen(false)}><Icon name="close" /></button><button className="language-toggle icon-button" type="button" aria-label={labels.language} title={labels.language} onClick={() => { const interfaceLanguage: InterfaceLanguage = language === 'zh-CN' ? 'en-US' : 'zh-CN'; void onUpdate((current) => ({ ...current, interfaceLanguage })); }}><Icon name="language" /></button><a className="github-link icon-button" href={PROJECT_REPOSITORY_URL} target="_blank" rel="noopener noreferrer" aria-label={labels.repository} title={labels.repository}><Icon name="github" /></a><a className="donation-link icon-button" href={PROJECT_DONATION_URL} target="_blank" rel="noopener noreferrer" aria-label={labels.donation} title={labels.donation}><img className="donation-link__logo" src="/assets/ko-fi-logomark.webp" alt="" /></a></div></header>
        <nav className="drawer-nav drawer-nav--labeled" aria-label={labels.nav}>{NAVIGATION.map((item) => {
          const active = panel === item.id;
          return <button key={item.id} type="button" className={active ? 'is-active' : ''} aria-label={item.label[language]} title={item.label[language]} aria-current={active ? 'page' : undefined} onClick={() => setPanel(item.id)}><Icon name={item.icon} />{active && <span>{item.label[language]}</span>}</button>;
        })}</nav>
        <div className="drawer-content">
          <div key={panel} className="drawer-panel" data-panel={panel}>
          {panel === 'sources' && <SourcesPanel settings={settings} operations={operations} counts={sourceCounts} states={sourceStates} onUpdate={onUpdate} onRefresh={onRefreshSource} modalBackground={() => dialogRef.current} />}
          {panel === 'appearance' && <AppearancePanel value={settings.appearance} onChange={(patch) => { void onUpdate((current) => ({ ...current, appearance: { ...current.appearance, ...patch } })); }} onChangeImage={onChangeImage} />}
          {panel === 'time' && <WidgetsPanel section="time" settings={settings} onUpdate={onUpdate} onClockScalePreview={onClockScalePreview} />}
          {panel === 'weather' && <WidgetsPanel section="weather" settings={settings} onUpdate={onUpdate} currentWeather={weather} />}
          {panel === 'search' && <WidgetsPanel section="search" settings={settings} onUpdate={onUpdate} />}
          {panel === 'shortcuts' && <ShortcutsPanel settings={settings} onUpdate={onUpdate} />}
          {panel === 'about' && <AboutPanel modalBackground={() => dialogRef.current} onCleared={(next) => { onDataCleared(next); setOpen(false); }} />}
          </div>
        </div>
      </div>
    </div>}
  </LanguageProvider>;
}

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}
