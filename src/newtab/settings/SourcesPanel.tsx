import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { PicTabSettings, SourceConfig, SourceType, TmdbSourceConfig } from '../../domain/types';
import type { ConnectionTestResult } from '../../sources/adapter';
import type { ImageEntry, ListImagesResult } from '../../sources/adapter';
import type { LocalImportResult } from '../../sources/local';
import type { LocalImageRecord } from '../../storage/imageDb';
import type { OriginPermissionOperationResult } from '../../lib/permissions';
import { SourceEditor, sourceTypeName } from './SourceEditor';
import { permissionTargetsForSource } from './SourceEditor';
import type { RemoteCacheLease } from '../sourceClient';
import { isolateModalBackground } from '../../lib/modalIsolation';
import { SourceStatus, type SourceStatusState } from '../components/SourceStatus';
import { Icon } from '../components/Icon';

export type SettingsUpdater = (updater: (current: PicTabSettings) => PicTabSettings) => Promise<PicTabSettings> | PicTabSettings | void;
export type TmdbMetadataResult = { ok: true; genres: { id: number; name: string }[]; languages: string[]; regions: string[] } | { ok: false; error: { message: string } };

export interface SourceOperations {
  test: (source: SourceConfig) => Promise<ConnectionTestResult>;
  importLocal: (sourceId: string, files: File[], options?: { uncommitted?: boolean }) => Promise<LocalImportResult>;
  delete: (source: SourceConfig) => Promise<void>;
  deleteCommittedLocal?: (source: Extract<SourceConfig, { type: 'local' }>, removeConfig: () => Promise<void>) => Promise<void>;
  loadTmdbMetadata: (source: TmdbSourceConfig) => Promise<TmdbMetadataResult>;
  withOriginPermissions: <T>(urls: string[], operation: () => Promise<T>) => Promise<OriginPermissionOperationResult<T>>;
  list?: (source: SourceConfig, options?: { offset?: number; limit?: number }) => Promise<ListImagesResult>;
  materializePreview?: (entries: readonly ImageEntry[]) => Promise<RemoteCacheLease>;
  listLocalFiles?: (sourceId: string) => Promise<LocalImageRecord[]>;
  deleteLocalImage?: (sourceId: string, imageId: string) => Promise<void>;
  reorderLocalImages?: (sourceId: string, orderedIds: string[]) => Promise<void>;
  completeLocalImport?: (sourceId: string) => Promise<void>;
  recoverLocalImports?: () => Promise<void>;
  abandonLocalImports?: () => void;
  refresh?: (source: SourceConfig) => Promise<void>;
  clearCache?: (source: SourceConfig) => Promise<void>;
}

export interface SourcesPanelProps {
  settings: PicTabSettings;
  operations: SourceOperations;
  counts: Record<string, number | undefined>;
  states?: Record<string, SourceLoadState | undefined>;
  onUpdate: SettingsUpdater;
  onRefresh: (sourceId: string) => void | Promise<void>;
  modalBackground?: () => HTMLElement | null;
}

export type SourceLoadState = SourceStatusState;

type SourceAvailabilityTone = 'ready' | 'loading' | 'stale' | 'error' | 'disabled' | 'unknown';

function sourceAvailability(source: SourceConfig, state?: SourceLoadState): { label: string; tone: SourceAvailabilityTone } {
  if (!source.enabled) return { label: '已停用', tone: 'disabled' };
  if (!state) return { label: '待检测', tone: 'unknown' };
  if (state.status === 'ready') return { label: '可用', tone: 'ready' };
  if (state.status === 'loading') return { label: '检测中', tone: 'loading' };
  if (state.status === 'stale') return { label: '缓存可用', tone: 'stale' };
  return { label: '不可用', tone: 'error' };
}

const SOURCE_TYPES: { type: SourceType; name: string; detail: string }[] = [
  { type: 'local', name: '本地图片', detail: '从当前设备导入' },
  { type: 'webdav', name: 'WebDAV', detail: '连接你的私有图库' },
  { type: 'direct', name: '在线图片 URL', detail: '逐行添加 HTTPS 图片' },
  { type: 'json-api', name: 'JSON API', detail: '映射自定义接口字段' },
  { type: 'tmdb', name: 'TMDB', detail: '电影与电视背景图' }
];

export function SourcesPanel({ settings, operations, counts, states = {}, onUpdate, onRefresh, modalBackground }: SourcesPanelProps) {
  const [editor, setEditor] = useState<{ source?: SourceConfig; type: SourceType; mode?: 'manage' | 'edit' } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ source: SourceConfig; restore: HTMLButtonElement } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [actionStates, setActionStates] = useState<Record<string, { kind: 'ready' | 'error' | 'loading'; message: string } | undefined>>({});

  const runSourceAction = async (source: SourceConfig, action: 'test' | 'refresh' | 'clear') => {
    setActionStates((states) => ({ ...states, [source.id]: { kind: 'loading', message: action === 'test' ? '正在测试连接…' : '正在刷新…' } }));
    try {
      const perform = async () => {
        if (action === 'test') {
          const result = await operations.test(source);
          if (!result.ok) throw new Error('test');
        } else if (action === 'refresh') {
          await operations.refresh?.(source); await onRefresh(source.id);
        } else await operations.clearCache?.(source);
      };
      const targets = action === 'clear' ? [] : permissionTargetsForSource(source);
      const permitted = targets.length ? await operations.withOriginPermissions(targets, perform) : { ok: true as const, value: await perform() };
      if (!permitted.ok) throw new Error('permission');
      setActionStates((states) => ({ ...states, [source.id]: { kind: 'ready', message: action === 'clear' ? '缓存已清除。' : '连接正常。' } }));
    } catch {
      setActionStates((states) => ({ ...states, [source.id]: { kind: 'error', message: action === 'clear' ? '无法清除缓存，请重试。' : action === 'test' ? '连接测试失败，请检查配置。' : '刷新失败，请重试。' } }));
    }
  };

  const saveSource = async (source: SourceConfig, options?: { stayOpen?: boolean }) => {
    await onUpdate((current) => {
      const sources = current.sources.some((item) => item.id === source.id)
        ? current.sources.map((item) => item.id === source.id ? source : item)
        : [...current.sources, source];
      return { ...current, sources, activeSourceId: source.id };
    });
    if (options?.stayOpen) setEditor((current) => current ? { ...current, source } : current);
    else {
      setEditor(null);
      setChoosing(false);
    }
    void Promise.resolve().then(() => onRefresh(source.id)).catch(() => {
      setActionStates((states) => ({ ...states, [source.id]: { kind: 'error', message: '图片源已保存，但刷新失败。请重试。' } }));
    });
  };

  const deleteSource = async (source: SourceConfig) => {
    if (source.type === 'local') {
      const removeConfig = async () => { await onUpdate((current) => {
        const sources = current.sources.filter((item) => item.id !== source.id);
        const nextActive = current.activeSourceId === source.id ? sources[0]?.id ?? null : current.activeSourceId;
        return { ...current, sources, activeSourceId: nextActive };
      }); };
      if (operations.deleteCommittedLocal) await operations.deleteCommittedLocal(source, removeConfig);
      else { await removeConfig(); await operations.delete(source); }
      setPendingDelete(null);
      setEditor(null);
      return;
    }
    await operations.delete(source);
    await onUpdate((current) => {
      const sources = current.sources.filter((item) => item.id !== source.id);
      const nextActive = current.activeSourceId === source.id ? sources[0]?.id ?? null : current.activeSourceId;
      return { ...current, sources, activeSourceId: nextActive };
    });
    setPendingDelete(null);
    setEditor(null);
  };

  const confirmation = pendingDelete ? createPortal(<DeleteConfirmation source={pendingDelete.source} background={modalBackground?.() ?? contentRef.current} restore={pendingDelete.restore} fallbackFocus={contentRef.current} onCancel={() => setPendingDelete(null)} onConfirm={() => deleteSource(pendingDelete.source)} />, document.body) : null;

  if (editor) return <><div ref={contentRef} tabIndex={-1}><SourceEditor source={editor.source} type={editor.type} initialMode={editor.mode} operations={operations} onSave={saveSource} onCancel={() => setEditor(null)} onDelete={editor.source ? (trigger) => setPendingDelete({ source: editor.source!, restore: trigger }) : undefined} onRefresh={onRefresh} /></div>{confirmation}</>;

  return (
    <><div ref={contentRef} tabIndex={-1}>
    <section className="settings-section" aria-labelledby="sources-title">
      <header className="settings-section__header"><p className="settings-eyebrow">图库</p><h2 id="sources-title">图片源</h2><p>添加多个来源，随时切换当前展示的图库。</p></header>
      <div className="source-list">
        {settings.sources.length === 0 && <div className="empty-state"><strong>还没有图片源</strong><span>添加后，PicTab 会立即显示其中的图片。</span></div>}
        {settings.sources.map((source) => {
          const availability = sourceAvailability(source, states[source.id]);
          return <article className={`source-card${settings.activeSourceId === source.id ? ' source-card--active' : ''}`} key={source.id}>
            <div className="source-card__top">
              <div><h3>{source.name}</h3><span>{sourceTypeName(source.type)}</span></div>
              <div className="source-card__badges">
                <span className={`source-availability source-availability--${availability.tone}`} aria-label={`图片源状态：${availability.label}`}>{availability.label}</span>
                {settings.activeSourceId === source.id && <span className="active-badge">正在使用</span>}
              </div>
            </div>
            <p>{counts[source.id] === undefined ? '图片数量待加载' : `${counts[source.id]} 张图片`} · {source.enabled ? '已启用' : '已停用'}</p>
            {states[source.id]?.status !== 'ready' && <SourceStatus state={states[source.id]} />}
            {actionStates[source.id] && <p className={actionStates[source.id]?.kind === 'error' ? 'source-card__error' : 'source-card__status'} role={actionStates[source.id]?.kind === 'error' ? 'alert' : 'status'}>{actionStates[source.id]?.message}</p>}
            <div className="source-card__actions">
              {settings.activeSourceId !== source.id && <button type="button" className="text-button text-button--with-icon" aria-label="使用此源" title="使用此源" onClick={() => void onUpdate((current) => ({ ...current, activeSourceId: source.id }))}><Icon name="check" /><span>使用</span></button>}
              <button type="button" className="text-button text-button--with-icon" aria-label={`重命名 ${source.name}`} title="重命名" onClick={() => setEditor({ source, type: source.type, mode: 'edit' })}><Icon name="edit" /><span>命名</span></button>
              <button type="button" className="text-button text-button--with-icon" aria-label={`编辑配置 ${source.name}`} title="配置" onClick={() => setEditor({ source, type: source.type, mode: 'manage' })}><Icon name="settings" /><span>配置</span></button>
              <button type="button" className="text-button text-button--with-icon" aria-label={`测试 ${source.name}`} title="测试" onClick={() => void runSourceAction(source, 'test')}><Icon name="test" /><span>测试</span></button>
              <button type="button" className="text-button text-button--with-icon" aria-label={`刷新 ${source.name}`} title="刷新" onClick={() => void runSourceAction(source, 'refresh')}><Icon name="refresh" /><span>刷新</span></button>
              {source.type !== 'local' && <button type="button" className="text-button text-button--with-icon" aria-label={`清除缓存 ${source.name}`} title="清除缓存" onClick={() => void runSourceAction(source, 'clear')}><Icon name="database" /><span>缓存</span></button>}
              <button type="button" className="text-button text-button--with-icon text-button--danger" aria-label={`删除 ${source.name}`} title="删除" onClick={(event) => setPendingDelete({ source, restore: event.currentTarget })}><Icon name="trash" /><span>删除</span></button>
            </div>
          </article>;
        })}
      </div>
      {choosing ? <div className="source-picker" aria-label="选择图片源类型">
        <div className="source-picker__header"><h3>选择来源</h3><button className="text-button text-button--with-icon" type="button" aria-label="取消" title="取消" onClick={() => setChoosing(false)}><Icon name="close" /><span>取消</span></button></div>
        {SOURCE_TYPES.map((item) => <button aria-label={item.name} type="button" key={item.type} onClick={() => { setEditor({ type: item.type }); setChoosing(false); }}><strong>{item.name}</strong><span>{item.detail}</span></button>)}
      </div> : <button className="button button--with-icon" type="button" aria-label="添加图片源" title="添加图片源" onClick={() => setChoosing(true)}><Icon name="plus" /><span>添加</span></button>}
    </section>
    </div>{confirmation}</>
  );
}

function DeleteConfirmation({ source, background, restore, fallbackFocus, onCancel, onConfirm }: { source: SourceConfig; background: HTMLElement | null; restore: HTMLButtonElement; fallbackFocus: HTMLElement | null; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const busyRef = useRef(busy); busyRef.current = busy;
  const cancelActionRef = useRef(onCancel); cancelActionRef.current = onCancel;
  useEffect(() => {
    const releaseIsolation = isolateModalBackground(background, () => cancelRef.current);
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); cancelActionRef.current(); }
      if (event.key === 'Tab') {
        if (event.shiftKey && document.activeElement === cancelRef.current) { event.preventDefault(); confirmRef.current?.focus(); }
        else if (!event.shiftKey && document.activeElement === confirmRef.current) { event.preventDefault(); cancelRef.current?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      releaseIsolation();
      if (restore.isConnected) restore.focus(); else fallbackFocus?.focus();
    };
  }, [background, fallbackFocus, restore]);
  const confirm = async () => {
    setBusy(true); setError(false);
    try { await onConfirm(); }
    catch { setBusy(false); setError(true); }
  };
  return <div className="confirm-backdrop"><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-source-title">
    <h3 id="delete-source-title">删除{source.name}</h3>
    <p>{source.type === 'local' ? '这会永久删除保存在浏览器中的本地图片，无法恢复。' : '这会移除配置和缓存，不会删除远端的原始图片。'}</p>
    {error && <p className="form-message form-message--error" role="alert">删除失败，配置仍然保留。请重试。</p>}
    <div><button ref={cancelRef} type="button" className="button button--secondary button--with-icon" aria-label="取消" title="取消" disabled={busy} onClick={onCancel}><Icon name="close" /><span>取消</span></button><button ref={confirmRef} type="button" className="button button--danger button--with-icon" aria-label={busy ? '正在删除…' : '确认删除'} title={busy ? '正在删除…' : '确认删除'} disabled={busy} onClick={() => void confirm()}>{busy ? <Icon name="refresh" /> : <Icon name="trash" />}<span>{busy ? '删除中' : '删除'}</span></button></div>
  </section></div>;
}
