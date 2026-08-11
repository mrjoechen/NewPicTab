import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { InterfaceLanguage, PicTabSettings } from '../../domain/types';
import { isolateModalBackground } from '../../lib/modalIsolation';
import { PROVIDERS } from '../../sources/providers';
import { PROJECT_REPOSITORY_URL } from '../../project';
import { clearAllPicTabData, type DataClearResult } from '../dataClear';
import { Icon } from '../components/Icon';
import { localizedList, useInterfaceLanguage } from '../i18n';

const EXTERNAL_HOSTS = new Set(['www.themoviedb.org', 'developer.themoviedb.org', 'github.com', 'gitlab.com', 'codeberg.org']);
const FALLBACK_FAILURE = 'partial local data';
const CLEAR_FAILURE_LABELS: Record<string, Record<InterfaceLanguage, string>> = {
  'settings and credentials': { 'zh-CN': '设置与凭据', 'en-US': 'Settings and credentials' },
  'local images and journals': { 'zh-CN': '本地图片与清理日志', 'en-US': 'Local images and cleanup journals' },
  'remote cache, catalog, weather, and cursors': { 'zh-CN': '远程缓存、目录、天气与切换游标', 'en-US': 'Remote cache, catalog, weather, and rotation cursors' },
  'source adapters': { 'zh-CN': '图片源适配器', 'en-US': 'Source adapters' },
  'remote image cache': { 'zh-CN': '远程图片缓存', 'en-US': 'Remote image cache' },
  'remote image catalog': { 'zh-CN': '远程图片目录', 'en-US': 'Remote image catalog' },
  'weather cache': { 'zh-CN': '天气缓存', 'en-US': 'Weather cache' },
  'browser journals and cursors': { 'zh-CN': '浏览器清理日志与切换游标', 'en-US': 'Browser cleanup journals and rotation cursors' },
  [FALLBACK_FAILURE]: { 'zh-CN': '部分本地数据', 'en-US': 'Some local data' }
};

export interface AboutPanelProps {
  version?: string;
  repositoryUrl?: string | null;
  clearData?: () => Promise<DataClearResult>;
  onCleared: (settings: PicTabSettings) => void;
  modalBackground?: () => HTMLElement | null;
}

export function AboutPanel({ version = runtimeVersion(), repositoryUrl = PROJECT_REPOSITORY_URL, clearData = clearAllPicTabData, onCleared, modalBackground }: AboutPanelProps) {
  const rootRef = useRef<HTMLElement>(null);
  const clearTriggerRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const repository = safeExternalUrl(repositoryUrl);
  const licenseUrl = runtimeAssetUrl('LICENSE.txt');

  return <section ref={rootRef} className="settings-section about-panel" aria-labelledby="about-title">
    <header className="settings-section__header"><p className="settings-eyebrow">PicTab {version}</p><h2 id="about-title">关于与隐私</h2><p>一张背景，一点时间，其余保持安静。</p></header>

    <div className="about-block"><h3>隐私</h3><p>PicTab 不包含统计、遥测或跟踪，也没有 PicTab 服务器；持久化配置不会上传到 PicTab 基础设施。</p><p>仅在启用对应功能时，PicTab 才会直接请求你选择的第三方：WebDAV 会把凭据发送给 WebDAV 服务；JSON API 会把配置的请求头发送给 API endpoint，并从你授权的图片主机或 CDN 下载图片；在线图片 URL 会直接请求相应图片主机；TMDB 会把 API 凭据发送给 TMDB API，并从 TMDB CDN 下载图片；天气会把城市或坐标发送给 Open-Meteo；主动使用当前位置时，坐标还会发送给 BigDataCloud 以识别城市名称；搜索控件会从内置搜索服务加载图标，提交后才把查询交给所选搜索引擎；快捷网址则进行普通网页导航。</p><p>图片源凭据保存在 Chrome 本地存储；这能避免浏览器同步，但无法防止可访问你已解锁浏览器配置文件的人读取。WebDAV 推荐使用应用专用密码。</p><p>已授予的站点访问权限可能继续保留，直到你在 Chrome 扩展设置中移除；清除数据不会擅自撤销权限。</p></div>

    <div className="about-block"><h3>源码与许可</h3><p>PicTab 是采用 MIT License 发布的开源软件，可自由使用、修改和分发，包括商业用途；分发时须保留版权与许可声明。</p><div className="about-links"><a href={licenseUrl} target="_blank" rel="noopener noreferrer">查看 MIT License</a>{repository ? <a href={repository} target="_blank" rel="noopener noreferrer">源码仓库</a> : <span>仓库地址尚未配置。</span>}</div></div>

    <div className="about-block"><h3>TMDB</h3><img className="tmdb-attribution__logo" src={runtimeAssetUrl('assets/tmdb-blue-short.svg')} alt="TMDB" /><p>{PROVIDERS.tmdb.attribution}</p><p>TMDB 内容与商标归其各自权利人所有；PicTab 未内置 API 凭据。</p><div className="about-links"><ExternalLink href={PROVIDERS.tmdb.applyUrl!}>申请 TMDB API 凭据</ExternalLink><ExternalLink href={PROVIDERS.tmdb.guideUrl}>TMDB 官方指南</ExternalLink><ExternalLink href={PROVIDERS.tmdb.attributionUrl!}>TMDB 标识与归因规范</ExternalLink></div></div>

    <div className="about-block about-danger"><h3>清除数据</h3><p>移除 PicTab 在此浏览器配置文件中的设置、凭据、图片与运行记录。</p><button ref={clearTriggerRef} type="button" className="button button--danger button--with-icon" aria-label="清除所有 PicTab 数据" title="清除所有 PicTab 数据" onClick={() => setConfirming(true)}><Icon name="trash" /><span>清除</span></button></div>

    {confirming && createPortal(<ClearDataConfirmation
      background={modalBackground?.() ?? rootRef.current}
      restore={clearTriggerRef.current}
      clearData={clearData}
      onCancel={() => setConfirming(false)}
      onCleared={(settings) => { setConfirming(false); onCleared(settings); }}
    />, document.body)}
  </section>;
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  const safe = safeExternalUrl(href);
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a> : null;
}

function ClearDataConfirmation({ background, restore, clearData, onCancel, onCleared }: { background: HTMLElement | null; restore: HTMLButtonElement | null; clearData: () => Promise<DataClearResult>; onCancel: () => void; onCleared: (settings: PicTabSettings) => void }) {
  const language = useInterfaceLanguage();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const busyRef = useRef(false); busyRef.current = busy;
  const cancelRefCallback = useRef(onCancel); cancelRefCallback.current = onCancel;

  useEffect(() => {
    const release = isolateModalBackground(background, () => cancelRef.current);
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); cancelRefCallback.current(); return; }
      if (event.key !== 'Tab') return;
      if (event.shiftKey && document.activeElement === cancelRef.current) { event.preventDefault(); confirmRef.current?.focus(); }
      else if (!event.shiftKey && document.activeElement === confirmRef.current) { event.preventDefault(); cancelRef.current?.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); release(); restore?.focus(); };
  }, [background, restore]);

  const confirm = async () => {
    if (busy) return;
    setBusy(true); setFailures([]);
    try {
      const result = await clearData();
      if (result.ok) { onCleared(result.settings); return; }
      setFailures(result.failures.map((failure) => failure in CLEAR_FAILURE_LABELS ? failure : FALLBACK_FAILURE));
    } catch { setFailures([FALLBACK_FAILURE]); }
    setBusy(false);
  };

  return <div className="confirm-backdrop"><section className="confirm-dialog confirm-dialog--wide" role="alertdialog" aria-modal="true" aria-labelledby="clear-data-title" aria-describedby="clear-data-description">
    <h3 id="clear-data-title">清除所有 PicTab 数据</h3>
    <section id="clear-data-description"><p>将从当前浏览器配置文件永久移除：</p><ul><li>设置与凭据</li><li>本地图片</li><li>远程图片缓存与目录</li><li>天气缓存</li><li>切换游标与清理日志</li></ul><p>不会删除 WebDAV 或 TMDB 上的远端内容。此操作无法撤销。</p></section>
    {failures.length > 0 && <p className="form-message form-message--error" role="alert">{language === 'zh-CN' ? `仍有数据未能清除：${localizedFailureList(failures, language)}。请重试。` : `Some data could not be cleared: ${localizedFailureList(failures, language)}. Try again.`}</p>}
    <div><button ref={cancelRef} type="button" className="button button--secondary button--with-icon" aria-label="取消" title="取消" disabled={busy} onClick={onCancel}><Icon name="close" /><span>取消</span></button><button ref={confirmRef} type="button" className="button button--danger button--with-icon" aria-label={busy ? '正在清除…' : '确认清除'} title={busy ? '正在清除…' : '确认清除'} disabled={busy} onClick={() => void confirm()}>{busy ? <Icon name="refresh" /> : <Icon name="trash" />}<span>{busy ? '清除中' : '清除'}</span></button></div>
  </section></div>;
}

function localizedFailureList(failures: string[], language: InterfaceLanguage): string {
  const labels = [...new Set(failures)].map((failure) => CLEAR_FAILURE_LABELS[failure]?.[language] ?? CLEAR_FAILURE_LABELS[FALLBACK_FAILURE]![language]);
  return localizedList(labels, language);
}

function runtimeVersion(): string {
  try { return chrome.runtime.getManifest?.().version ?? '未知版本'; }
  catch { return '未知版本'; }
}

function runtimeAssetUrl(path: string): string {
  try { return chrome.runtime.getURL?.(path) ?? `/${path}`; }
  catch { return `/${path}`; }
}

function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && EXTERNAL_HOSTS.has(url.hostname) ? url.toString() : null; }
  catch { return null; }
}
