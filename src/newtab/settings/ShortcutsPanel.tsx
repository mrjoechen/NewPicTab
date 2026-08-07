import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';

import {
  boundedShortcutDockScale,
  canonicalShortcutTitle,
  isSafeShortcutIcon,
  MAX_SHORTCUT_ICON_BYTES,
  MAX_SHORTCUT_ICON_DIMENSION,
  MAX_SHORTCUTS,
  SHORTCUT_DOCK_SCALE_MAX,
  SHORTCUT_DOCK_SCALE_MIN,
  SHORTCUT_DOCK_SCALE_STEP,
  shortcutIconDimensions,
  validateShortcutTitle,
  validateShortcutUrl
} from '../../domain/shortcuts';
import type { PicTabSettings, Shortcut, ShortcutVisibleLimit } from '../../domain/types';
import type { SettingsUpdater } from './SourcesPanel';
import { Icon } from '../components/Icon';
import { defaultFaviconUrl } from '../components/ShortcutDock';

const ICON_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const OUTPUT_ICON_DIMENSION = 128;
const IMAGE_DECODE_TIMEOUT_MS = 3_000;

export interface ShortcutsPanelProps {
  settings: PicTabSettings;
  onUpdate: SettingsUpdater;
}

interface ShortcutDraft {
  id: string | null;
  title: string;
  url: string;
  customIcon?: string;
}

export async function validateShortcutIcon(file: File): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }> {
  if (!ICON_TYPES.has(file.type)) return { ok: false, error: '图标仅支持 PNG、JPEG 或 WebP。' };
  if (file.size > MAX_SHORTCUT_ICON_BYTES) return { ok: false, error: '图标不能超过 128 KB。' };
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { return { ok: false, error: '无法读取图标文件。' }; }
  const header = shortcutIconDimensions(bytes, file.type);
  if (!header) return { ok: false, error: '图标文件格式与声明类型不匹配。' };
  if (header.width > MAX_SHORTCUT_ICON_DIMENSION || header.height > MAX_SHORTCUT_ICON_DIMENSION) return { ok: false, error: '图标尺寸不能超过 1024 × 1024。' };
  const dataUrl = bytesToDataUrl(bytes, file.type);
  let image: HTMLImageElement | null;
  try { image = await loadImage(dataUrl); }
  catch { return { ok: false, error: '图标文件无法显示或读取超时。' }; }
  if (!image) return { ok: false, error: '图标文件无法显示或读取超时。' };
  try {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (width <= 0 || height <= 0 || width > MAX_SHORTCUT_ICON_DIMENSION || height > MAX_SHORTCUT_ICON_DIMENSION) return { ok: false, error: '图标尺寸不能超过 1024 × 1024。' };
    if (width <= OUTPUT_ICON_DIMENSION && height <= OUTPUT_ICON_DIMENSION) return { ok: true, dataUrl };
    const resized = resizeIcon(image, width, height);
    return resized && isSafeShortcutIcon(resized)
      ? { ok: true, dataUrl: resized }
      : { ok: false, error: '无法处理图标文件。' };
  } finally {
    image.onload = null; image.onerror = null; image.src = '';
  }
}

export function ShortcutsPanel({ settings, onUpdate }: ShortcutsPanelProps) {
  const [draft, setDraft] = useState<ShortcutDraft | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileId = useId();
  const editorTitleId = useId();
  const addRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const operationGeneration = useRef(0);
  const draftFocusKey = draft ? draft.id ?? 'new' : null;
  const atLimit = settings.shortcuts.length >= MAX_SHORTCUTS;
  const savedScale = boundedShortcutDockScale(settings.widgets.shortcuts.scale);
  const [draftScale, setDraftScale] = useState(String(savedScale));

  useEffect(() => {
    if (draftFocusKey !== null) queueMicrotask(() => nameRef.current?.focus());
  }, [draftFocusKey]);
  useEffect(() => setDraftScale(String(savedScale)), [savedScale]);
  useEffect(() => () => { operationGeneration.current += 1; }, []);

  const restoreFocus = () => {
    const preferred = restoreFocusRef.current;
    queueMicrotask(() => {
      if (preferred?.isConnected && !(preferred as HTMLButtonElement).disabled) preferred.focus();
      else addRef.current?.focus();
    });
  };
  const startAdd = (trigger: HTMLElement) => {
    if (busy || atLimit) { setError(`最多可添加 ${MAX_SHORTCUTS} 个快捷网址。`); return; }
    operationGeneration.current += 1; restoreFocusRef.current = trigger; setError(''); setDraft({ id: null, title: '', url: '' });
  };
  const startEdit = (shortcut: Shortcut, trigger: HTMLElement) => {
    if (busy) return;
    operationGeneration.current += 1; restoreFocusRef.current = trigger; setError(''); setDraft({ ...shortcut });
  };
  const closeEditor = () => {
    if (busy) return;
    operationGeneration.current += 1; setError(''); setDraft(null); restoreFocus();
  };
  useEffect(() => {
    if (draftFocusKey === null) return;
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="alertdialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      closeEditor();
    };
    document.addEventListener('keydown', onDocumentKeyDown, true);
    return () => document.removeEventListener('keydown', onDocumentKeyDown, true);
  }, [busy, draftFocusKey]);

  const updateSetting = async (updater: (current: PicTabSettings) => PicTabSettings, failure: string): Promise<boolean> => {
    const generation = ++operationGeneration.current;
    setBusy(true); setError('');
    try { await onUpdate(updater); return generation === operationGeneration.current; }
    catch { if (generation === operationGeneration.current) setError(failure); return false; }
    finally { if (generation === operationGeneration.current) setBusy(false); }
  };
  const patchEnabled = (enabled: boolean) => updateSetting((current) => ({ ...current, widgets: { ...current.widgets, shortcuts: { ...current.widgets.shortcuts, enabled } } }), '无法保存快捷网址设置。');
  const patchMaxVisible = (maxVisible: ShortcutVisibleLimit) => updateSetting((current) => ({ ...current, widgets: { ...current.widgets, shortcuts: { ...current.widgets.shortcuts, maxVisible } } }), '无法保存快捷网址设置。');
  const patchScale = (scale: number) => updateSetting((current) => ({ ...current, widgets: { ...current.widgets, shortcuts: { ...current.widgets.shortcuts, scale } } }), '无法保存快捷网址设置。');
  const previewScale = (value: string) => {
    const scale = boundedShortcutDockScale(Number(value));
    setDraftScale(String(scale));
  };
  const commitScale = (value = draftScale) => {
    const scale = boundedShortcutDockScale(Number(value));
    if (Math.abs(scale - savedScale) > 0.004) void patchScale(scale);
  };

  const save = async () => {
    if (!draft || busy) return;
    const snapshot = { ...draft };
    const titleError = validateShortcutTitle(snapshot.title);
    if (titleError) { setError(titleError); return; }
    const title = canonicalShortcutTitle(snapshot.title)!;
    const urlError = validateShortcutUrl(snapshot.url);
    if (urlError) { setError(urlError); return; }
    const url = new URL(snapshot.url).toString();
    const generation = ++operationGeneration.current;
    setBusy(true); setError('');
    try {
      await onUpdate((current) => {
        if (!snapshot.id && current.shortcuts.length >= MAX_SHORTCUTS) throw new ShortcutLimitError();
        const id = snapshot.id ?? uniqueShortcutId(current.shortcuts);
        const shortcut: Shortcut = { id, title, url, ...(snapshot.customIcon ? { customIcon: snapshot.customIcon } : {}) };
        return {
          ...current,
          shortcuts: snapshot.id
            ? current.shortcuts.map((item) => item.id === snapshot.id ? shortcut : item)
            : [...current.shortcuts, shortcut]
        };
      });
      if (generation === operationGeneration.current) { setDraft(null); restoreFocus(); }
    } catch (reason) {
      if (generation === operationGeneration.current) setError(reason instanceof ShortcutLimitError ? `最多可添加 ${MAX_SHORTCUTS} 个快捷网址。` : '无法保存快捷网址。');
    } finally { if (generation === operationGeneration.current) setBusy(false); }
  };

  const remove = async (id: string) => {
    const completed = await updateSetting((current) => ({ ...current, shortcuts: current.shortcuts.filter((shortcut) => shortcut.id !== id) }), '无法删除快捷网址。');
    if (completed) queueMicrotask(() => addRef.current?.focus());
  };

  const move = async (id: string, direction: -1 | 1) => {
    await updateSetting((current) => {
      const index = current.shortcuts.findIndex((shortcut) => shortcut.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.shortcuts.length) return current;
      const shortcuts = [...current.shortcuts];
      [shortcuts[index], shortcuts[target]] = [shortcuts[target]!, shortcuts[index]!];
      return { ...current, shortcuts };
    }, '无法调整快捷网址顺序。');
  };

  const chooseIcon = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !draft || busy) return;
    const generation = ++operationGeneration.current;
    const draftId = draft.id;
    setBusy(true); setError('');
    try {
      const result = await validateShortcutIcon(file);
      if (generation !== operationGeneration.current) return;
      if (result.ok) setDraft((current) => current && current.id === draftId ? { ...current, customIcon: result.dataUrl } : current);
      else setError(result.error);
    } catch {
      if (generation === operationGeneration.current) setError('无法处理图标文件。');
    } finally {
      if (generation === operationGeneration.current) setBusy(false);
    }
  };

  return <section className="settings-section shortcuts-panel" aria-labelledby="shortcuts-title">
    <header className="settings-section__header"><h2 id="shortcuts-title">快捷网址</h2><p>只显示你手动添加的 HTTPS 网址。</p></header>
    <div className="settings-form">
      <label className="check-field"><input type="checkbox" checked={settings.widgets.shortcuts.enabled} disabled={busy} onChange={(event) => void patchEnabled(event.target.checked)} />显示快捷网址</label>
      <label className="field"><span>最多显示</span><select value={settings.widgets.shortcuts.maxVisible} disabled={busy} onChange={(event) => void patchMaxVisible(Number(event.target.value) as ShortcutVisibleLimit)}>{Array.from({ length: 10 }, (_, index) => index + 3).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="field range-field"><span>Dock 大小</span><input aria-label="Dock 大小" type="range" min={SHORTCUT_DOCK_SCALE_MIN} max={SHORTCUT_DOCK_SCALE_MAX} step={SHORTCUT_DOCK_SCALE_STEP} value={draftScale} disabled={busy} onChange={(event) => previewScale(event.target.value)} onPointerUp={(event) => commitScale(event.currentTarget.value)} onPointerCancel={(event) => commitScale(event.currentTarget.value)} onBlur={(event) => commitScale(event.currentTarget.value)} /><small>{dockScaleLabel(Number(draftScale))}</small></label>
      <button ref={addRef} className="button button--primary button--with-icon" type="button" aria-label="添加快捷网址" disabled={busy || draft !== null || atLimit} title={atLimit ? `最多可添加 ${MAX_SHORTCUTS} 个` : '添加快捷网址'} onClick={(event) => startAdd(event.currentTarget)}><Icon name="plus" /><span>添加</span></button>
      {atLimit && <p className="form-message" role="status">最多可添加 {MAX_SHORTCUTS} 个快捷网址。</p>}
      {settings.shortcuts.length > 0 && <ul className="shortcut-list" aria-label="已添加的快捷网址">
        {settings.shortcuts.map((shortcut, index) => <li key={shortcut.id} data-testid="shortcut-row">
          <span className="shortcut-list__name">{shortcut.title}</span>
          <div className="shortcut-list__actions">
            <button type="button" aria-label={`上移 ${shortcut.title}`} title="上移" disabled={busy || draft !== null || index === 0} onClick={() => void move(shortcut.id, -1)}><Icon name="arrow-up" /><span>上</span></button>
            <button type="button" aria-label={`下移 ${shortcut.title}`} title="下移" disabled={busy || draft !== null || index === settings.shortcuts.length - 1} onClick={() => void move(shortcut.id, 1)}><Icon name="arrow-down" /><span>下</span></button>
            <button type="button" aria-label={`编辑 ${shortcut.title}`} title="编辑" disabled={busy || draft !== null} onClick={(event) => startEdit(shortcut, event.currentTarget)}><Icon name="edit" /><span>编辑</span></button>
            <button type="button" aria-label={`删除 ${shortcut.title}`} title="删除" disabled={busy || draft !== null} onClick={() => void remove(shortcut.id)}><Icon name="trash" /><span>删除</span></button>
          </div>
        </li>)}
      </ul>}
      {draft && <section className="shortcut-editor" role="region" aria-labelledby={editorTitleId}>
        <h3 className="visually-hidden" id={editorTitleId}>{draft.id ? '编辑快捷网址' : '添加快捷网址'}</h3>
        <label className="field"><span>名称</span><input ref={nameRef} value={draft.title} maxLength={80} disabled={busy} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <label className="field"><span>网址</span><input type="url" inputMode="url" value={draft.url} disabled={busy} placeholder="https://example.com" onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label>
        <div className="shortcut-icon-field">
          <label className="field" htmlFor={fileId}><span>自定义图标</span><input id={fileId} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={(event) => void chooseIcon(event)} /></label>
          {draft.customIcon
            ? <div className="shortcut-icon-preview"><img src={draft.customIcon} alt="图标预览" /><button type="button" aria-label="移除图标" title="移除图标" disabled={busy} onClick={() => setDraft((current) => { if (!current) return current; const { customIcon: _icon, ...next } = current; return next; })}><Icon name="trash" /><span>移除</span></button></div>
            : <ShortcutWebsiteIconPreview url={draft.url} />}
        </div>
        {error && <p className="form-message form-message--error" role="alert">{error}</p>}
        <div className="shortcut-editor__actions"><button className="button button--primary button--with-icon" type="button" aria-label="保存快捷网址" title="保存快捷网址" disabled={busy} onClick={() => void save()}><Icon name="save" /><span>保存</span></button><button className="button button--secondary button--with-icon" type="button" aria-label="取消" title="取消" disabled={busy} onClick={closeEditor}><Icon name="close" /><span>取消</span></button></div>
      </section>}
      {!draft && error && <p className="form-message form-message--error" role="alert">{error}</p>}
    </div>
  </section>;
}

class ShortcutLimitError extends Error {}

function uniqueShortcutId(shortcuts: readonly Shortcut[]): string {
  const existing = new Set(shortcuts.map((shortcut) => shortcut.id));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `shortcut-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    if (!existing.has(id)) return id;
  }
  return `shortcut-${Date.now().toString(36)}-${existing.size}`;
}

function dockScaleLabel(value: number): string {
  return `${Math.round(boundedShortcutDockScale(value) * 100)}%`;
}

function ShortcutWebsiteIconPreview({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const icon = defaultFaviconUrl(url);
  useEffect(() => setFailed(false), [icon]);
  return icon && !failed
    ? <div className="shortcut-icon-preview"><img src={icon} alt="网站图标预览" referrerPolicy="no-referrer" onError={() => setFailed(true)} /></div>
    : null;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (result: HTMLImageElement | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); image.onload = null; image.onerror = null;
      if (!result) image.src = '';
      resolve(result);
    };
    const timer = window.setTimeout(() => finish(null), IMAGE_DECODE_TIMEOUT_MS);
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    image.src = dataUrl;
  });
}

function resizeIcon(image: HTMLImageElement, width: number, height: number): string | null {
  try {
    const scale = Math.min(OUTPUT_ICON_DIMENSION / width, OUTPUT_ICON_DIMENSION / height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/webp', 0.84);
  }
  catch { return null; }
}

function bytesToDataUrl(bytes: Uint8Array, type: string): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8_192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  return `data:${type};base64,${btoa(binary)}`;
}
