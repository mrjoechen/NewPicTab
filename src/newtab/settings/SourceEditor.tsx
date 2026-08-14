import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { createPortal } from 'react-dom';

import type { DirectEntry, SourceConfig, SourceType, TmdbDiscoverFilters, TmdbSourceConfig } from '../../domain/types';
import type { ImageEntry, SafeWebDavDirectory } from '../../sources/adapter';
import { PROVIDERS } from '../../sources/providers';
import type { SourceOperations, TmdbMetadataResult } from './SourcesPanel';
import type { RemoteCacheLease } from '../sourceClient';
import { Icon } from '../components/Icon';
import { canonicalWebDavChildDirectory, canonicalWebDavDirectory } from '../../sources/webdavUrl';
import { useInterfaceLanguage } from '../i18n';

interface SourceEditorProps {
  source?: SourceConfig;
  type: SourceType;
  initialMode?: SourceEditorMode;
  operations: SourceOperations;
  onSave: (source: SourceConfig, options?: { stayOpen?: boolean }) => Promise<void>;
  onCancel: () => void;
  onDelete?: (trigger: HTMLButtonElement) => void;
  onRefresh: (sourceId: string) => void | Promise<void>;
}

type EditorStatus = { kind: 'success' | 'error' | 'info'; message: string } | null;
type SourceEditorMode = 'manage' | 'edit';
type HeaderRow = { id: string; key: string; value: string; revealed: boolean };
type JsonDiscovery = { key: string; origins: string[] };
type DirectRow = DirectEntry & { rowKey: string };
type WebDavDiscovery = { rootUrl: string; currentUrl: string; directories: SafeWebDavDirectory[]; path: string[] };

const MOVIE_FEEDS = [
  ['popular', '热门电影'], ['top-rated', '高分电影'], ['now-playing', '正在上映'], ['upcoming', '即将上映'],
  ['trending-daily', '今日趋势'], ['trending-weekly', '本周趋势'], ['discover', '发现']
] as const;
const TV_FEEDS = [
  ['popular', '热门剧集'], ['top-rated', '高分剧集'], ['airing-today', '今日播出'], ['on-the-air', '正在播出'],
  ['trending-daily', '今日趋势'], ['trending-weekly', '本周趋势'], ['discover', '发现']
] as const;
const PREVIEW_PAGE_SIZE = 6;
type PreviewCursor = { nextOffset: number; hasMore: boolean };

export function SourceEditor({ source, type, initialMode = 'edit', operations, onSave, onCancel, onDelete, onRefresh }: SourceEditorProps) {
  const interfaceLanguage = useInterfaceLanguage();
  const [editorMode, setEditorMode] = useState<SourceEditorMode>(() => source ? initialMode : 'edit');
  const [id, setId] = useState(() => source?.id ?? createId());
  const [now] = useState(() => source?.createdAt ?? Date.now());
  const [name, setName] = useState(source?.name ?? '');
  const [url, setUrl] = useState(source?.type === 'webdav' ? source.url : '');
  const [webDavPath, setWebDavPath] = useState<string[]>(() => source?.type === 'webdav' ? source.folderPath ?? [] : []);
  const [username, setUsername] = useState(source?.type === 'webdav' ? source.username : '');
  const [password, setPassword] = useState(source?.type === 'webdav' ? source.password : '');
  const [recursive, setRecursive] = useState(source?.type === 'webdav' || source?.type === 'local' ? source.includeSubdirectories : false);
  const [directRows, setDirectRows] = useState<DirectRow[]>(() => source?.type === 'direct' ? source.entries.map((entry) => ({ ...entry, rowKey: createId() })) : [{ id: createId(), rowKey: createId(), url: '' }]);
  const [endpoint, setEndpoint] = useState(source?.type === 'json-api' ? source.endpoint : '');
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(() => Object.entries(source?.type === 'json-api' ? source.headers : {}).map(([key, value], index) => ({ id: `header-${index}`, key, value, revealed: false })));
  const [authorizedImageOrigins, setAuthorizedImageOrigins] = useState(source?.type === 'json-api' ? source.authorizedImageOrigins : []);
  const [arrayPath, setArrayPath] = useState(source?.type === 'json-api' ? source.arrayPath : 'results');
  const [imagePath, setImagePath] = useState(source?.type === 'json-api' ? source.fields.imageUrl : 'url');
  const [stableIdPath, setStableIdPath] = useState(source?.type === 'json-api' ? source.fields.stableId ?? '' : 'id');
  const [titlePath, setTitlePath] = useState(source?.type === 'json-api' ? source.fields.title ?? '' : '');
  const [authorPath, setAuthorPath] = useState(source?.type === 'json-api' ? source.fields.author ?? '' : '');
  const [sourcePagePath, setSourcePagePath] = useState(source?.type === 'json-api' ? source.fields.sourcePage ?? '' : '');
  const [widthPath, setWidthPath] = useState(source?.type === 'json-api' ? source.fields.width ?? '' : '');
  const [heightPath, setHeightPath] = useState(source?.type === 'json-api' ? source.fields.height ?? '' : '');
  const [startingPage, setStartingPage] = useState(source?.type === 'json-api' ? source.startingPage : 1);
  const [pageParam, setPageParam] = useState(source?.type === 'json-api' ? source.pageParam ?? '' : '');
  const [tmdbToken, setTmdbToken] = useState(source?.type === 'tmdb' ? source.token : '');
  const [tmdbMedia, setTmdbMedia] = useState<TmdbSourceConfig['media']>(source?.type === 'tmdb' ? source.media : 'movie');
  const [tmdbFeed, setTmdbFeed] = useState<string>(source?.type === 'tmdb' ? source.feed : 'popular');
  const [tmdbGenre, setTmdbGenre] = useState(source?.type === 'tmdb' ? String(source.discoverFilters.with_genres ?? '') : '');
  const [tmdbLanguage, setTmdbLanguage] = useState(source?.type === 'tmdb' ? String(source.discoverFilters.language ?? '') : '');
  const [tmdbRegion, setTmdbRegion] = useState(source?.type === 'tmdb' ? String(source.discoverFilters.region ?? '') : '');
  const [tmdbYear, setTmdbYear] = useState(source?.type === 'tmdb' ? String(source.discoverFilters[source.media === 'movie' ? 'primary_release_year' : 'first_air_date_year'] ?? '') : '');
  const [tmdbRating, setTmdbRating] = useState(source?.type === 'tmdb' ? String(source.discoverFilters['vote_average.gte'] ?? '') : '');
  const [tmdbSort, setTmdbSort] = useState(source?.type === 'tmdb' ? String(source.discoverFilters.sort_by ?? '') : '');
  const [tmdbDateFrom, setTmdbDateFrom] = useState(source?.type === 'tmdb' ? String(source.discoverFilters[source.media === 'movie' ? 'primary_release_date.gte' : 'first_air_date.gte'] ?? '') : '');
  const [tmdbDateTo, setTmdbDateTo] = useState(source?.type === 'tmdb' ? String(source.discoverFilters[source.media === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte'] ?? '') : '');
  const [tmdbPage, setTmdbPage] = useState(source?.type === 'tmdb' ? Number(source.discoverFilters.page ?? 1) : 1);
  const [tmdbMetadata, setTmdbMetadata] = useState<TmdbMetadataResult | null>(null);
  const [tested, setTested] = useState(type === 'local');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<EditorStatus>(null);
  const [preview, setPreview] = useState<ImageEntry[]>([]);
  const [previewCursor, setPreviewCursor] = useState<PreviewCursor>({ nextOffset: 0, hasMore: false });
  const [previewLoading, setPreviewLoading] = useState(false);
  const [jsonDiscovery, setJsonDiscovery] = useState<JsonDiscovery | null>(null);
  const [webDavDiscovery, setWebDavDiscovery] = useState<WebDavDiscovery | null>(null);
  const [webDavPickerOpen, setWebDavPickerOpen] = useState(false);
  const [webDavPickerBusy, setWebDavPickerBusy] = useState(false);
  const [webDavPickerStatus, setWebDavPickerStatus] = useState<EditorStatus>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [localItems, setLocalItems] = useState<{ id: string; name: string; url?: string }[]>([]);
  const localUrls = useRef<Set<string>>(new Set());
  const localGalleryMounted = useRef(false);
  const localLoadGeneration = useRef(0);
  const previewLeases = useRef<RemoteCacheLease[]>([]);
  const mounted = useRef(true);
  const requestGeneration = useRef(0);
  const webDavBrowseGeneration = useRef(0);
  const tmdbConnectionGeneration = useRef(0);
  const pendingLocalCleanup = useRef<Extract<SourceConfig, { type: 'local' }> | null>(null);
  const managedPreviewLoaded = useRef(false);

  const releasePreview = useCallback(() => {
    for (const lease of previewLeases.current) lease.release();
    previewLeases.current = [];
    setPreviewCursor({ nextOffset: 0, hasMore: false });
    setPreviewLoading(false);
  }, []);

  const releaseLocalUrls = useCallback(() => {
    for (const itemUrl of localUrls.current) { try { URL.revokeObjectURL(itemUrl); } catch { /* best-effort private preview cleanup */ } }
    localUrls.current.clear();
  }, []);

  const loadLocalGallery = useCallback(async () => {
    if (source?.type !== 'local' || !operations.listLocalFiles) return;
    const generation = ++localLoadGeneration.current;
    let records;
    try { records = await operations.listLocalFiles(source.id); }
    catch {
      if (localGalleryMounted.current && generation === localLoadGeneration.current) setStatus({ kind: 'error', message: '无法读取本地图片，请重试。' });
      return;
    }
    const nextUrls = new Set<string>();
    const next = records.map((record) => {
      try { const itemUrl = URL.createObjectURL(record.blob); nextUrls.add(itemUrl); return { id: record.id, name: record.name, url: itemUrl }; }
      catch { return { id: record.id, name: record.name }; }
    });
    if (!localGalleryMounted.current || generation !== localLoadGeneration.current) {
      for (const itemUrl of nextUrls) { try { URL.revokeObjectURL(itemUrl); } catch { /* best-effort stale preview cleanup */ } }
      return;
    }
    releaseLocalUrls(); localUrls.current = nextUrls; setLocalItems(next);
  }, [operations, releaseLocalUrls, source]);

  useEffect(() => {
    localGalleryMounted.current = true;
    void loadLocalGallery();
    return () => { localGalleryMounted.current = false; localLoadGeneration.current += 1; releaseLocalUrls(); };
  }, [loadLocalGallery, releaseLocalUrls]);
  useEffect(() => {
    if (type !== 'local' || source || !operations.recoverLocalImports) return;
    let active = true;
    void operations.recoverLocalImports().catch(() => {
      if (active) setStatus({ kind: 'error', message: '本地清理失败，请重试后再导入图片。' });
    });
    return () => { active = false; };
  }, [operations, source, type]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestGeneration.current += 1; webDavBrowseGeneration.current += 1; tmdbConnectionGeneration.current += 1; releasePreview(); };
  }, [releasePreview]);

  const tmdbConnectionIdentity = `${tmdbToken.trim()}\u0000${tmdbMedia}`;
  useEffect(() => {
    if (type !== 'tmdb') return;
    requestGeneration.current += 1; tmdbConnectionGeneration.current += 1; releasePreview(); setPreview([]); setBusy(false);
    setTested(false);
    setTmdbMetadata(null);
  }, [releasePreview, tmdbConnectionIdentity, type]);

  useEffect(() => {
    if (type !== 'tmdb') return;
    requestGeneration.current += 1; releasePreview(); setPreview([]); setBusy(false);
  }, [releasePreview, tmdbDateFrom, tmdbDateTo, tmdbFeed, tmdbGenre, tmdbLanguage, tmdbPage, tmdbRating, tmdbRegion, tmdbSort, tmdbYear, type]);

  const feeds = tmdbMedia === 'movie' ? MOVIE_FEEDS : TV_FEEDS;
  useEffect(() => {
    if (!feeds.some(([value]) => value === tmdbFeed)) setTmdbFeed('popular');
  }, [feeds, tmdbFeed]);
  const chooseTmdbGenre = (value: string) => {
    setTmdbGenre(value);
    if (value && tmdbFeed !== 'discover') setTmdbFeed('discover');
  };

  const draft = useMemo(() => {
    try {
      const base = { id, name: name.trim(), type, enabled: source?.enabled ?? true, createdAt: now, updatedAt: source?.updatedAt ?? Date.now() } as const;
      if (!base.name) throw new Error('请填写图片源名称。');
      if (type === 'local') return { ...base, type, includeSubdirectories: recursive } satisfies SourceConfig;
      if (type === 'webdav') {
        const webDavUrl = url.trim();
        const canonicalRoot = canonicalWebDavDirectory(webDavUrl);
        if (!canonicalRoot || !buildWebDavDirectoryUrl(canonicalRoot.url.href, webDavPath)) throw new Error('WebDAV 地址必须是 HTTPS 目录地址，且不支持查询参数或片段。');
        return { ...base, type, url: canonicalRoot.url.href, folderPath: webDavPath, username: username.trim(), password, includeSubdirectories: recursive } satisfies SourceConfig;
      }
      if (type === 'direct') {
        const entries = directRows.filter((row) => row.url.trim()).map((row): DirectEntry => ({ id: row.id, url: row.url.trim(), ...(row.label?.trim() ? { label: row.label.trim() } : {}) }));
        return { ...base, type, entries } satisfies SourceConfig;
      }
      if (type === 'json-api') {
        const requestHeaders: Record<string, string> = {};
        for (const row of headerRows) { const key = row.key.trim(); if (key) requestHeaders[key] = row.value; }
        return { ...base, type, endpoint: endpoint.trim(), headers: requestHeaders, authorizedImageOrigins, arrayPath: arrayPath.trim(), fields: { imageUrl: imagePath.trim(), ...(stableIdPath.trim() ? { stableId: stableIdPath.trim() } : {}), ...(titlePath.trim() ? { title: titlePath.trim() } : {}), ...(authorPath.trim() ? { author: authorPath.trim() } : {}), ...(sourcePagePath.trim() ? { sourcePage: sourcePagePath.trim() } : {}), ...(widthPath.trim() ? { width: widthPath.trim() } : {}), ...(heightPath.trim() ? { height: heightPath.trim() } : {}) }, startingPage, ...(pageParam.trim() ? { pageParam: pageParam.trim() } : {}) } satisfies SourceConfig;
      }
      const discoverFilters: TmdbDiscoverFilters = source?.type === 'tmdb' ? { ...source.discoverFilters } : {};
      setOrDelete(discoverFilters, 'with_genres', tmdbGenre);
      setOrDelete(discoverFilters, 'language', tmdbLanguage);
      setOrDelete(discoverFilters, 'region', tmdbRegion);
      delete discoverFilters.primary_release_year; delete discoverFilters.first_air_date_year;
      if (tmdbYear) discoverFilters[tmdbMedia === 'movie' ? 'primary_release_year' : 'first_air_date_year'] = Number(tmdbYear);
      setOrDelete(discoverFilters, 'vote_average.gte', tmdbRating ? Number(tmdbRating) : '');
      setOrDelete(discoverFilters, 'sort_by', tmdbSort);
      delete discoverFilters['primary_release_date.gte']; delete discoverFilters['primary_release_date.lte'];
      delete discoverFilters['first_air_date.gte']; delete discoverFilters['first_air_date.lte'];
      setOrDelete(discoverFilters, tmdbMedia === 'movie' ? 'primary_release_date.gte' : 'first_air_date.gte', tmdbDateFrom);
      setOrDelete(discoverFilters, tmdbMedia === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte', tmdbDateTo);
      discoverFilters.page = tmdbPage;
      return tmdbMedia === 'movie'
        ? { ...base, type: 'tmdb', token: tmdbToken.trim(), media: 'movie', feed: tmdbFeed as Extract<TmdbSourceConfig, { media: 'movie' }>['feed'], discoverFilters } satisfies SourceConfig
        : { ...base, type: 'tmdb', token: tmdbToken.trim(), media: 'tv', feed: tmdbFeed as Extract<TmdbSourceConfig, { media: 'tv' }>['feed'], discoverFilters } satisfies SourceConfig;
    } catch (error) {
      return error instanceof Error ? error : new Error('配置无效。');
    }
  }, [arrayPath, authorPath, authorizedImageOrigins, directRows, endpoint, headerRows, heightPath, id, imagePath, name, now, pageParam, password, recursive, source, sourcePagePath, stableIdPath, startingPage, titlePath, tmdbDateFrom, tmdbDateTo, tmdbFeed, tmdbGenre, tmdbLanguage, tmdbMedia, tmdbPage, tmdbRating, tmdbRegion, tmdbSort, tmdbToken, tmdbYear, type, url, username, webDavPath, widthPath]);

  const jsonDiscoveryKey = useMemo(() => JSON.stringify({ endpoint, headers: headerRows.map(({ key, value }) => [key, value]), arrayPath, imagePath, stableIdPath, titlePath, authorPath, sourcePagePath, widthPath, heightPath, startingPage, pageParam }), [arrayPath, authorPath, endpoint, headerRows, heightPath, imagePath, pageParam, sourcePagePath, stableIdPath, startingPage, titlePath, widthPath]);
  const initialJsonDiscoveryKey = useRef(jsonDiscoveryKey);
  const previousJsonDiscoveryKey = useRef(jsonDiscoveryKey);
  useEffect(() => {
    if (previousJsonDiscoveryKey.current === jsonDiscoveryKey) return;
    previousJsonDiscoveryKey.current = jsonDiscoveryKey;
    requestGeneration.current += 1;
    releasePreview();
    setPreview([]); setJsonDiscovery(null); setTested(false); setBusy(false); setStatus(null);
  }, [jsonDiscoveryKey, releasePreview]);

  const beginPreviewRequest = () => {
    const generation = ++requestGeneration.current;
    releasePreview(); setPreview([]);
    return generation;
  };
  const requestIsCurrent = (generation: number) => mounted.current && requestGeneration.current === generation;
  const tmdbConnectionRequestIsCurrent = (generation: number) => mounted.current && tmdbConnectionGeneration.current === generation;

  const materializePreviewPage = async (previewDraft: SourceConfig, generation: number, options: { offset: number; allowEmpty?: boolean }): Promise<{ ok: true; entries: ImageEntry[]; nextOffset: number; hasMore: boolean } | { ok: false; message: string } | null> => {
    if (!operations.list || !operations.materializePreview) return { ok: true, entries: [], nextOffset: options.offset, hasMore: false };
    const listed = await operations.list(previewDraft, { offset: options.offset, limit: PREVIEW_PAGE_SIZE });
    if (!requestIsCurrent(generation)) return null;
    if (!listed.ok) {
      if (options.allowEmpty && listed.error.code === 'empty') return { ok: true, entries: [], nextOffset: options.offset, hasMore: false };
      return { ok: false, message: listed.error.message };
    }
    const pageImages = listed.images.slice(0, PREVIEW_PAGE_SIZE);
    const lease = await operations.materializePreview(pageImages);
    if (!requestIsCurrent(generation)) { lease.release(); return null; }
    previewLeases.current.push(lease);
    return {
      ok: true,
      entries: lease.entries,
      nextOffset: listed.nextOffset ?? options.offset + pageImages.length,
      hasMore: listed.hasMore === true
    };
  };

  const loadManagedPreview = useCallback(async (target: SourceConfig | undefined = source, options: { quiet?: boolean } = {}) => {
    if (!target || target.type === 'local') return;
    const generation = beginPreviewRequest();
    setBusy(true); setPreviewLoading(true);
    if (!options.quiet) setStatus({ kind: 'info', message: '正在刷新图片预览…' });
    try {
      const loadPreview = () => materializePreviewPage(target, generation, { offset: 0, allowEmpty: true });
      const targets = permissionTargetsForSource(target);
      const result = targets.length
        ? await operations.withOriginPermissions(targets, loadPreview)
        : { ok: true as const, value: await loadPreview() };
      if (!requestIsCurrent(generation)) return;
      if (!result.ok) { setStatus({ kind: 'error', message: result.error.message }); return; }
      if (!result.value) return;
      if (!result.value.ok) { setStatus({ kind: 'error', message: result.value.message }); return; }
      setPreview(result.value.entries);
      setPreviewCursor({ nextOffset: result.value.nextOffset, hasMore: result.value.hasMore });
      setStatus({ kind: result.value.entries.length ? 'success' : 'info', message: result.value.entries.length ? `已加载 ${result.value.entries.length} 张预览。` : '当前图片源没有可预览图片。' });
    } catch {
      if (requestIsCurrent(generation)) setStatus({ kind: 'error', message: '加载图片预览失败，请重试。' });
    } finally {
      if (requestIsCurrent(generation)) { setBusy(false); setPreviewLoading(false); }
    }
  }, [operations, releasePreview, source]);

  useEffect(() => {
    if (!source || editorMode !== 'manage' || source.type === 'local' || managedPreviewLoaded.current) return;
    managedPreviewLoaded.current = true;
    void loadManagedPreview(source, { quiet: true });
  }, [editorMode, loadManagedPreview, source]);

  const closeWebDavPicker = () => {
    webDavBrowseGeneration.current += 1;
    setWebDavPickerOpen(false);
    setWebDavPickerBusy(false);
    setWebDavPickerStatus(null);
  };

  const clearWebDavTest = () => {
    requestGeneration.current += 1;
    webDavBrowseGeneration.current += 1;
    releasePreview(); setPreview([]); setWebDavDiscovery(null); setWebDavPickerOpen(false); setWebDavPickerBusy(false); setWebDavPickerStatus(null); setTested(false); setBusy(false); setStatus(null);
  };

  const materializeRemotePreview = async (previewDraft: SourceConfig, generation: number, options: { allowEmpty?: boolean } = {}) => materializePreviewPage(previewDraft, generation, { offset: 0, allowEmpty: options.allowEmpty });

  const webDavSuccessMessage = (previewCount: number): string => {
    if (previewCount > 0) return `连接成功，已预览 ${previewCount} 张图片。`;
    return '文件夹已选择，当前文件夹没有可预览图片。';
  };

  const browseWebDavPath = async (nextPath: string[], openingName?: string) => {
    if (draft instanceof Error || draft.type !== 'webdav' || !webDavDiscovery) return;
    const rootUrl = webDavDiscovery.rootUrl;
    const nextUrl = buildWebDavDirectoryUrl(rootUrl, nextPath);
    if (!nextUrl) { setWebDavPickerStatus({ kind: 'error', message: '目标文件夹无效，请重新选择。' }); return; }
    const generation = ++webDavBrowseGeneration.current;
    setWebDavPickerBusy(true);
    setWebDavPickerStatus({ kind: 'info', message: openingName ? `正在打开“${openingName}”…` : '正在打开文件夹…' });
    try {
      const response = await operations.test({ ...draft, url: rootUrl, folderPath: nextPath });
      if (!mounted.current || webDavBrowseGeneration.current !== generation) return;
      if (!response.ok) { setWebDavPickerStatus({ kind: 'error', message: response.error.message }); return; }
      if (response.protected !== true) { setWebDavPickerStatus({ kind: 'error', message: 'WebDAV 返回了无效的安全测试结果。' }); return; }
      const directories = response.directories ?? [];
      setWebDavDiscovery({ rootUrl, currentUrl: nextUrl, directories, path: nextPath });
      setWebDavPickerStatus({ kind: 'success', message: directories.length ? '已进入文件夹，可继续选择下一层。' : '已进入文件夹，当前层没有子文件夹。' });
    } catch {
      if (mounted.current && webDavBrowseGeneration.current === generation) setWebDavPickerStatus({ kind: 'error', message: '打开文件夹失败，请重试。' });
    } finally {
      if (mounted.current && webDavBrowseGeneration.current === generation) setWebDavPickerBusy(false);
    }
  };

  const browseWebDavDirectory = async (selectedId: string) => {
    if (!webDavDiscovery) return;
    const directory = webDavDiscovery.directories.find((item) => item.id === selectedId);
    if (!directory) { clearWebDavTest(); setStatus({ kind: 'error', message: '目标文件夹无效，请重新测试。' }); return; }
    await browseWebDavPath([...webDavDiscovery.path, ...directory.relativeSegments], directory.name);
  };

  const browseWebDavAncestor = async (pathLength: number) => {
    if (!webDavDiscovery || pathLength === webDavDiscovery.path.length) return;
    const nextPath = webDavDiscovery.path.slice(0, pathLength);
    await browseWebDavPath(nextPath, pathLength === 0 ? '根目录' : nextPath.at(-1));
  };

  const loadConfirmedWebDavDirectory = async (confirmedDraft: Extract<SourceConfig, { type: 'webdav' }>, generation: number) => {
    try {
      const previewResult = await materializeRemotePreview(confirmedDraft, generation, { allowEmpty: true });
      if (!requestIsCurrent(generation) || !previewResult) return;
      if (!previewResult.ok) { setStatus({ kind: 'error', message: `无法加载所选文件夹：${previewResult.message}` }); return; }
      setPreview(previewResult.entries);
      setPreviewCursor({ nextOffset: previewResult.nextOffset, hasMore: previewResult.hasMore });
      setTested(true);
      setPreviewLoading(false);
      if (source && editorMode === 'manage') {
        setStatus({ kind: 'info', message: '正在保存目标文件夹…' });
        await onSave({ ...confirmedDraft, updatedAt: Date.now() }, { stayOpen: true });
        if (!requestIsCurrent(generation)) return;
        setStatus({ kind: 'success', message: previewResult.entries.length ? `目标文件夹已更新，已预览 ${previewResult.entries.length} 张图片。` : '目标文件夹已更新，当前文件夹没有可预览图片。' });
        return;
      }
      setStatus({ kind: 'success', message: webDavSuccessMessage(previewResult.entries.length) });
    } catch {
      if (requestIsCurrent(generation)) setStatus({ kind: 'error', message: '加载所选文件夹图片失败，请重试。' });
    } finally {
      if (requestIsCurrent(generation)) { setBusy(false); setPreviewLoading(false); }
    }
  };

  const confirmWebDavDirectory = () => {
    if (draft instanceof Error || draft.type !== 'webdav' || !webDavDiscovery) return;
    const selectedUrl = webDavDiscovery.rootUrl;
    const selectedPath = webDavDiscovery.path;
    const confirmedDraft: Extract<SourceConfig, { type: 'webdav' }> = { ...draft, url: selectedUrl, folderPath: selectedPath };
    const generation = beginPreviewRequest();
    setWebDavPath(selectedPath); setTested(false); setBusy(true); setPreviewLoading(true); setStatus({ kind: 'info', message: '正在加载所选文件夹的图片…' });
    setWebDavPickerOpen(false); setWebDavPickerBusy(false); setWebDavPickerStatus(null);
    void loadConfirmedWebDavDirectory(confirmedDraft, generation);
  };

  const openWebDavPicker = async () => {
    if (draft instanceof Error) { setStatus({ kind: 'error', message: draft.message }); return; }
    if (draft.type !== 'webdav') return;
    const generation = ++webDavBrowseGeneration.current;
    const previousStatus = status;
    setBusy(true);
    try {
      const operation = () => mounted.current && webDavBrowseGeneration.current === generation ? operations.test(draft) : Promise.resolve(null);
      const permissionUrls = permissionTargetsForSource(draft);
      if (permissionUrls.length) setStatus({ kind: 'info', message: '请在浏览器弹出的权限窗口中允许访问目标域名，之后会自动继续测试。' });
      const response = permissionUrls.length
        ? await operations.withOriginPermissions(permissionUrls, operation)
        : { ok: true as const, value: await operation() };
      if (!mounted.current || webDavBrowseGeneration.current !== generation) return;
      if (!response.ok) { setStatus({ kind: 'error', message: response.error.message }); return; }
      if (response.value === null) return;
      if (!response.value.ok) { setStatus({ kind: 'error', message: response.value.error.message }); return; }
      if (response.value.protected !== true) { setStatus({ kind: 'error', message: 'WebDAV 返回了无效的安全测试结果。' }); return; }
      const baseUrl = buildWebDavDirectoryUrl(draft.url, []);
      if (!baseUrl) { setStatus({ kind: 'error', message: 'WebDAV 地址无效。' }); return; }
      const currentUrl = buildWebDavDirectoryUrl(baseUrl, draft.folderPath ?? []);
      if (!currentUrl) { setStatus({ kind: 'error', message: 'WebDAV 文件夹路径无效。' }); return; }
      const directories = response.value.directories ?? [];
      setStatus(previousStatus);
      setWebDavDiscovery({ rootUrl: baseUrl, currentUrl, directories, path: draft.folderPath ?? [] });
      setWebDavPickerStatus({ kind: 'success', message: directories.length ? '连接成功。请选择目标文件夹。' : '连接成功。当前文件夹没有子文件夹，可直接确认当前文件夹。' });
      setWebDavPickerOpen(true);
    } catch {
      if (mounted.current && webDavBrowseGeneration.current === generation) setStatus({ kind: 'error', message: '连接测试失败，请检查配置后重试。' });
    } finally {
      if (mounted.current && webDavBrowseGeneration.current === generation) setBusy(false);
    }
  };

  const runTest = async () => {
    if (draft instanceof Error) { setStatus({ kind: 'error', message: draft.message }); return; }
    if (draft.type === 'webdav') { await openWebDavPicker(); return; }
    if (draft.type === 'json-api') return;
    const tmdbGeneration = draft.type === 'tmdb' ? ++tmdbConnectionGeneration.current : tmdbConnectionGeneration.current;
    const generation = beginPreviewRequest();
    setBusy(true); setStatus(null);
    try {
      const operation = () => {
        const current = draft.type === 'tmdb' ? tmdbConnectionRequestIsCurrent(tmdbGeneration) : requestIsCurrent(generation);
        return current ? operations.test(draft) : Promise.resolve(null);
      };
      const permissionUrls = permissionTargetsForSource(draft);
      if (permissionUrls.length) setStatus({ kind: 'info', message: '请在浏览器弹出的权限窗口中允许访问目标域名，之后会自动继续测试。' });
      const response = permissionUrls.length
        ? await operations.withOriginPermissions(permissionUrls, operation)
        : { ok: true as const, value: await operation() };
      if (draft.type === 'tmdb' ? !tmdbConnectionRequestIsCurrent(tmdbGeneration) : !requestIsCurrent(generation)) return;
      if (!response.ok) { setStatus({ kind: 'error', message: response.error.message }); return; }
      if (response.value === null) return;
      if (!response.value.ok) { setStatus({ kind: 'error', message: response.value.error.message }); setPreview(response.value.entries ?? []); return; }
      if (draft.type === 'tmdb') {
        setTested(true);
        setTmdbMetadata(null);
        setStatus({ kind: 'success', message: '连接成功。正在加载配置选项…' });
        setBusy(false);
        void operations.loadTmdbMetadata(draft).then((metadata) => {
          if (!tmdbConnectionRequestIsCurrent(tmdbGeneration)) return;
          if (!metadata.ok) {
            setStatus({ kind: 'error', message: '连接成功，但配置选项加载失败，请重试测试。' });
            return;
          }
          setTmdbMetadata(metadata);
          setStatus({ kind: 'success', message: '连接成功。' });
        }, () => {
          if (tmdbConnectionRequestIsCurrent(tmdbGeneration)) setStatus({ kind: 'error', message: '连接成功，但配置选项加载失败，请重试测试。' });
        });
        return;
      }
      setTested(true);
      const previewResult = await materializeRemotePreview(draft, generation);
      if (!requestIsCurrent(generation) || !previewResult) return;
      if (!previewResult.ok) { setStatus({ kind: 'error', message: previewResult.message }); return; }
      const previewEntries = previewResult.entries;
      setPreview(previewEntries);
      setPreviewCursor({ nextOffset: previewResult.nextOffset, hasMore: previewResult.hasMore });
      setStatus({ kind: 'success', message: previewEntries.length ? `连接成功，已预览 ${Math.min(previewEntries.length, PREVIEW_PAGE_SIZE)} 张图片。` : '连接成功。' });
    } catch {
      if (requestIsCurrent(generation)) setStatus({ kind: 'error', message: '连接测试失败，请检查配置后重试。' });
    } finally { if (requestIsCurrent(generation)) setBusy(false); }
  };

  const discoverJsonOrigins = async () => {
    if (draft instanceof Error) { setStatus({ kind: 'error', message: draft.message }); return; }
    if (draft.type !== 'json-api') return;
    const responsePromise = operations.withOriginPermissions([draft.endpoint], () => operations.test({ ...draft, authorizedImageOrigins: [] }));
    const generation = beginPreviewRequest();
    setBusy(true); setStatus(null); setJsonDiscovery(null); setTested(false);
    try {
      const response = await responsePromise;
      if (!requestIsCurrent(generation)) return;
      if (!response.ok) { setStatus({ kind: 'error', message: response.error.message }); return; }
      if (!response.value.ok) { setStatus({ kind: 'error', message: response.value.error.message }); return; }
      if (response.value.protected !== true) { setStatus({ kind: 'error', message: 'API 返回了无效的安全测试结果。' }); return; }
      const origins = response.value.imageOrigins ?? [];
      setJsonDiscovery({ key: jsonDiscoveryKey, origins });
      setStatus({ kind: 'success', message: origins.length ? `已发现 ${origins.length} 个图片域，请继续授权以完成预览。` : 'API 连接成功，未发现独立图片域；请继续完成预览。' });
    } catch {
      if (requestIsCurrent(generation)) setStatus({ kind: 'error', message: 'API 测试失败，请检查配置后重试。' });
    } finally { if (requestIsCurrent(generation)) setBusy(false); }
  };

  const completeJsonPreview = async () => {
    if (draft instanceof Error || draft.type !== 'json-api' || !jsonDiscovery || jsonDiscovery.key !== jsonDiscoveryKey) return;
    const permissionPromise = operations.withOriginPermissions([draft.endpoint, ...jsonDiscovery.origins], async () => undefined);
    const generation = beginPreviewRequest();
    setBusy(true); setStatus(null); setTested(false);
    try {
      const permission = await permissionPromise;
      if (!requestIsCurrent(generation)) return;
      if (!permission.ok) { setStatus({ kind: 'error', message: permission.error.message }); return; }
      const testedDraft = { ...draft, authorizedImageOrigins: [...jsonDiscovery.origins] };
      const previewResult = await materializeRemotePreview(testedDraft, generation);
      if (!requestIsCurrent(generation) || !previewResult) return;
      if (!previewResult.ok) { setStatus({ kind: 'error', message: previewResult.message }); return; }
      setAuthorizedImageOrigins([...jsonDiscovery.origins]);
      setPreview(previewResult.entries);
      setPreviewCursor({ nextOffset: previewResult.nextOffset, hasMore: previewResult.hasMore });
      setTested(true);
      setStatus({ kind: 'success', message: previewResult.entries.length ? `连接成功，已预览 ${previewResult.entries.length} 张图片。` : '连接成功。' });
    } catch {
      if (requestIsCurrent(generation)) setStatus({ kind: 'error', message: '图片域授权或预览失败，请重试。' });
    } finally { if (requestIsCurrent(generation)) setBusy(false); }
  };

  const save = async () => {
    if (draft instanceof Error) { setStatus({ kind: 'error', message: draft.message }); return; }
    if (draft.type === 'tmdb' && !tested) { setStatus({ kind: 'error', message: '请先测试 TMDB 连接。' }); return; }
    if (draft.type === 'json-api' && (!source || initialJsonDiscoveryKey.current !== jsonDiscoveryKey) && !tested) { setStatus({ kind: 'error', message: '请先完成 API 测试和图片域授权。' }); return; }
    if (draft.type === 'local' && !source && pendingFiles.length === 0) { setStatus({ kind: 'error', message: '请先导入至少一张有效图片。' }); return; }
    setBusy(true);
    try {
      if (draft.type === 'local' && !source) {
        let localDraft = draft;
        if (pendingLocalCleanup.current) {
          try { await operations.delete(pendingLocalCleanup.current); }
          catch {
            setStatus({ kind: 'error', message: '本地清理失败，未再次导入图片。请重试清理。' });
            return;
          }
          pendingLocalCleanup.current = null;
          const retryId = createId();
          setId(retryId);
          localDraft = { ...localDraft, id: retryId };
        }

        try { await operations.recoverLocalImports?.(); }
        catch { setStatus({ kind: 'error', message: '本地清理失败，未再次导入图片。请重试清理。' }); return; }

        let imported;
        try {
          imported = await operations.importLocal(localDraft.id, pendingFiles, { uncommitted: true });
        } catch {
          try {
            await operations.delete(localDraft);
            pendingLocalCleanup.current = null;
            setId(createId());
            setStatus({ kind: 'error', message: '导入失败，已清理本地图片，请重试。' });
          } catch {
            pendingLocalCleanup.current = localDraft;
            setStatus({ kind: 'error', message: '本地清理失败，未再次导入图片。请重试清理。' });
          }
          return;
        }
        setStatus({ kind: imported.failures.length ? 'error' : 'success', message: `已导入 ${imported.imported} 张图片。` });
        if (imported.imported === 0) {
          try { await operations.completeLocalImport?.(localDraft.id); }
          catch { setStatus({ kind: 'error', message: '本地导入状态清理失败，请重试。' }); }
          return;
        }
        try { await onSave({ ...localDraft, updatedAt: Date.now() }); }
        catch {
          try {
            await operations.delete(localDraft);
            pendingLocalCleanup.current = null;
            setId(createId());
            setStatus({ kind: 'error', message: '保存失败，已清理本地图片，请重试。' });
          } catch {
            pendingLocalCleanup.current = localDraft;
            setStatus({ kind: 'error', message: '本地清理失败，未再次导入图片。请重试清理。' });
          }
          return;
        }
        try { await operations.completeLocalImport?.(localDraft.id); }
        catch { setStatus({ kind: 'error', message: '图片源已保存，但本地导入状态更新失败。' }); }
        return;
      }
      await onSave({ ...draft, updatedAt: Date.now() });
    } catch { setStatus({ kind: 'error', message: '保存失败，请重试。' }); }
    finally { setBusy(false); }
  };

  const tmdbGenres = tmdbMetadata?.ok ? tmdbMetadata.genres : [];
  const tmdbLanguages = tmdbMetadata?.ok ? tmdbMetadata.languages ?? [] : [];
  const tmdbRegions = tmdbMetadata?.ok ? tmdbMetadata.regions ?? [] : [];
  const languageNames = useMemo(() => displayNames(interfaceLanguage, 'language'), [interfaceLanguage]);
  const regionNames = useMemo(() => displayNames(interfaceLanguage, 'region'), [interfaceLanguage]);

  const importFiles = async (files: File[]) => {
    setPendingFiles(files);
    if (source?.type !== 'local') return;
    setBusy(true);
    try {
      const result = await operations.importLocal(source.id, files);
      setPendingFiles([]);
      await loadLocalGallery();
      await onRefresh(source.id);
      setStatus({ kind: result.failures.length ? 'error' : 'success', message: `已导入 ${result.imported} 张图片${result.failures.length ? `，${result.failures.length} 张未导入` : ''}。` });
    } catch { setStatus({ kind: 'error', message: '导入本地图片失败，请重试。' }); }
    finally { if (mounted.current) setBusy(false); }
  };

  const deleteLocalItem = async (imageId: string) => {
    if (source?.type !== 'local' || !operations.deleteLocalImage) return;
    try { await operations.deleteLocalImage(source.id, imageId); await loadLocalGallery(); await onRefresh(source.id); }
    catch { if (mounted.current) setStatus({ kind: 'error', message: '删除本地图片失败，请重试。' }); }
  };

  const moveLocalItem = async (imageId: string, delta: -1 | 1) => {
    if (source?.type !== 'local' || !operations.reorderLocalImages) return;
    const index = localItems.findIndex((item) => item.id === imageId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= localItems.length) return;
    const previous = [...localItems]; const next = [...localItems]; [next[index], next[target]] = [next[target]!, next[index]!];
    setLocalItems(next);
    try { await operations.reorderLocalImages(source.id, next.map((item) => item.id)); await onRefresh(source.id); }
    catch { if (mounted.current) { setLocalItems(previous); setStatus({ kind: 'error', message: '调整图片顺序失败，已恢复。' }); await loadLocalGallery(); } }
  };

  const loadMorePreview = async () => {
    if (previewLoading || !previewCursor.hasMore || draft instanceof Error || draft.type === 'local') return;
    const generation = requestGeneration.current;
    setPreviewLoading(true);
    try {
      const previewResult = await materializePreviewPage(draft, generation, { offset: previewCursor.nextOffset, allowEmpty: true });
      if (!requestIsCurrent(generation) || !previewResult) return;
      if (!previewResult.ok) { setStatus({ kind: 'error', message: previewResult.message }); setPreviewCursor((current) => ({ ...current, hasMore: false })); return; }
      setPreview((current) => [...current, ...previewResult.entries]);
      setPreviewCursor({ nextOffset: previewResult.nextOffset, hasMore: previewResult.hasMore });
    } catch {
      if (requestIsCurrent(generation)) setStatus({ kind: 'error', message: '加载更多图片预览失败，请重试。' });
    } finally {
      if (requestIsCurrent(generation)) setPreviewLoading(false);
    }
  };

  const onPreviewScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (element.scrollHeight - element.scrollTop - element.clientHeight > 48) return;
    void loadMorePreview();
  };

  const closeEditor = () => { requestGeneration.current += 1; tmdbConnectionGeneration.current += 1; releasePreview(); onCancel(); };
  const localGallery = type === 'local' && localItems.length > 0 && <div className="local-gallery" aria-label="本地图片">
    {localItems.map((item, index) => <article key={item.id} className="local-gallery__item">
      {item.url ? <ThumbnailImage src={item.url} alt={item.name} /> : <div className="local-gallery__placeholder">{item.name}</div>}
      <div><span title={item.name}>{item.name}</span><div>
        <button type="button" className="text-button text-button--with-icon" aria-label={`上移 ${item.name}`} title="上移" disabled={index === 0} onClick={() => void moveLocalItem(item.id, -1)}><Icon name="arrow-up" /><span>上</span></button>
        <button type="button" className="text-button text-button--with-icon" aria-label={`下移 ${item.name}`} title="下移" disabled={index === localItems.length - 1} onClick={() => void moveLocalItem(item.id, 1)}><Icon name="arrow-down" /><span>下</span></button>
        <button type="button" className="text-button text-button--with-icon text-button--danger" aria-label={`删除 ${item.name}`} title="删除" onClick={() => void deleteLocalItem(item.id)}><Icon name="trash" /><span>删除</span></button>
      </div></div>
    </article>)}
  </div>;
  const previewList = preview.length > 0 || previewLoading ? <div className="source-preview" aria-label="连接预览" onScroll={onPreviewScroll}>
    {preview.length > 0 && <div className="source-preview__grid">
      {preview.map((entry) => 'url' in entry && entry.url ? <ThumbnailImage key={entry.id} src={entry.url} alt="图片预览缩略图" title={entry.description ?? '图片预览'} /> : null)}
    </div>}
    {previewLoading && <p className="source-preview__loading" role="status">{preview.length ? '正在加载更多预览…' : '正在加载图片预览…'}</p>}
    {!previewLoading && previewCursor.hasMore && <button className="text-button text-button--with-icon source-preview__more" type="button" aria-label="加载更多预览" title="加载更多预览" onClick={() => void loadMorePreview()}><Icon name="arrow-down" /><span>加载更多</span></button>}
  </div> : null;
  const webDavPickerDialog = webDavPickerOpen && webDavDiscovery && createPortal(<div className="webdav-picker-backdrop">
    <section className="webdav-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="webdav-picker-title">
      <header className="webdav-picker-dialog__header">
        <div><p className="settings-eyebrow">WebDAV</p><h3 id="webdav-picker-title">选择 WebDAV 文件夹</h3></div>
        <button className="text-button text-button--with-icon" type="button" aria-label="取消选择" title="取消" disabled={webDavPickerBusy} onClick={closeWebDavPicker}><Icon name="close" /><span>取消</span></button>
      </header>
      <div className="webdav-picker">
        <p className="webdav-picker__path">当前路径：/{webDavDiscovery.path.join('/')}</p>
        <div className="webdav-picker__browser" aria-label="WebDAV 文件夹层级">
          <nav className="webdav-picker__crumbs" aria-label="当前文件夹路径">
            <button type="button" className="webdav-picker__crumb" disabled={webDavPickerBusy || webDavDiscovery.path.length === 0} onClick={() => void browseWebDavAncestor(0)}>根目录</button>
            {webDavDiscovery.path.map((segment, index) => <button key={`${segment}-${index}`} type="button" className="webdav-picker__crumb" disabled={webDavPickerBusy || index === webDavDiscovery.path.length - 1} onClick={() => void browseWebDavAncestor(index + 1)}>{segment}</button>)}
          </nav>
          <div className="webdav-picker__folders" aria-label="子文件夹">
            {webDavDiscovery.directories.length
              ? webDavDiscovery.directories.map((directory) => <button key={directory.id} type="button" className="webdav-picker__folder" aria-label={`打开文件夹 ${directory.name}`} title={directory.name} disabled={webDavPickerBusy} onClick={() => void browseWebDavDirectory(directory.id)}><Icon name="folder" /><span>{directory.name}</span></button>)
              : <p className="webdav-picker__empty">当前层没有子文件夹</p>}
          </div>
        </div>
        {webDavPickerStatus && <p className={`form-message form-message--${webDavPickerStatus.kind}`} role={webDavPickerStatus.kind === 'error' ? 'alert' : 'status'}>{webDavPickerStatus.message}</p>}
      </div>
      <div className="webdav-picker-dialog__actions">
        <button className="button button--secondary button--with-icon" type="button" aria-label="取消" title="取消" disabled={webDavPickerBusy} onClick={closeWebDavPicker}><Icon name="close" /><span>取消</span></button>
        <button className="button button--with-icon" type="button" aria-label={webDavPickerBusy ? '正在确认选择…' : '确认选择'} title={webDavPickerBusy ? '正在确认选择…' : '确认选择'} disabled={webDavPickerBusy} onClick={() => void confirmWebDavDirectory()}>{webDavPickerBusy ? <Icon name="refresh" /> : <Icon name="check" />}<span>{webDavPickerBusy ? '加载中' : '确认选择'}</span></button>
      </div>
    </section>
  </div>, document.body);

  if (source && editorMode === 'manage') return (
    <>
    <section className="source-editor source-manager" aria-labelledby="source-editor-title">
      <header className="source-editor__header">
        <button type="button" className="text-button text-button--with-icon" aria-label="返回" title="返回" onClick={closeEditor}><Icon name="arrow-left" /><span>返回</span></button>
        <div><p className="settings-eyebrow">图片源配置</p><h2 id="source-editor-title">管理 {sourceTypeName(type)}</h2></div>
      </header>
      <div className="source-manager__overview">
        <div>
          <p className="settings-eyebrow">当前图片源</p>
          <h3>{source.name}</h3>
        </div>
        <SourceConfigSummary source={source} />
      </div>
      {type === 'local' && <div className="local-dropzone" data-testid="local-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void importFiles(Array.from(event.dataTransfer.files)); }}><label className="file-field"><span>导入本地图片</span><input aria-label="导入本地图片" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple onChange={(event) => void importFiles(Array.from(event.target.files ?? []))} /><small>选择文件或拖到这里；图片只保存在当前浏览器中。</small></label></div>}
      <div className="source-manager__actions">
        {source.type === 'webdav' && <button className="button button--secondary button--with-icon" type="button" aria-label="修改目标文件夹" title="修改目标文件夹" onClick={() => void runTest()} disabled={busy}>{busy ? <Icon name="refresh" /> : <Icon name="folder" />}<span>{busy ? '打开中' : '修改目标文件夹'}</span></button>}
        {source.type !== 'local' && <button className="button button--secondary button--with-icon" type="button" aria-label="刷新预览" title="刷新预览" onClick={() => void loadManagedPreview(source)} disabled={busy}>{busy ? <Icon name="refresh" /> : <Icon name="image" />}<span>{busy ? '刷新中' : '刷新预览'}</span></button>}
        <button className="button button--with-icon" type="button" aria-label="编辑完整配置" title="编辑完整配置" onClick={() => { setEditorMode('edit'); setStatus(null); }}><Icon name="edit" /><span>编辑完整配置</span></button>
      </div>
      {status && <p className={`form-message form-message--${status.kind}`} role={status.kind === 'error' ? 'alert' : 'status'}>{status.message}</p>}
      {type === 'local' ? localGallery : <section className="source-manager__preview" aria-labelledby="source-preview-title">
        <h3 id="source-preview-title">图片预览</h3>
        {previewList ?? <p className="source-manager__empty-preview">暂无可预览图片</p>}
      </section>}
      <div className="editor-actions">
        {onDelete && <button className="text-button text-button--with-icon text-button--danger" type="button" aria-label="删除图片源" title="删除图片源" onClick={(event) => onDelete(event.currentTarget)}><Icon name="trash" /><span>删除</span></button>}
      </div>
    </section>
    {webDavPickerDialog}
    </>
  );

  return (
    <>
    <section className="source-editor" aria-labelledby="source-editor-title">
      <header className="source-editor__header">
        <button type="button" className="text-button text-button--with-icon" aria-label="返回" title="返回" onClick={closeEditor}><Icon name="arrow-left" /><span>返回</span></button>
        <div><p className="settings-eyebrow">{source ? '编辑图片源' : '添加图片源'}</p><h2 id="source-editor-title">{sourceTypeName(type)}</h2></div>
      </header>
      <div className="settings-form">
        <label className="field"><span>图片源名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：家庭相册" autoComplete="off" /></label>
        {type === 'local' && <div className="local-dropzone" data-testid="local-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void importFiles(Array.from(event.dataTransfer.files)); }}><label className="file-field"><span>导入本地图片</span><input aria-label="导入本地图片" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple onChange={(event) => void importFiles(Array.from(event.target.files ?? []))} /><small>选择文件或拖到这里；图片只保存在当前浏览器中。</small></label></div>}
        {type === 'webdav' && <>
          <p className="credential-note">密码会保存在当前浏览器配置中；这不是密码库，任何能解锁此浏览器个人资料的人都可能恢复它。</p>
          <label className="field"><span>WebDAV 地址</span><input type="url" value={url} onChange={(event) => { setUrl(event.target.value); setWebDavPath([]); clearWebDavTest(); }} placeholder="https://dav.example.com/photos/" /></label>
          <label className="field"><span>用户名</span><input value={username} onChange={(event) => { setUsername(event.target.value); clearWebDavTest(); }} autoComplete="username" /></label>
          <label className="field"><span>密码</span><input type="password" value={password} onChange={(event) => { setPassword(event.target.value); clearWebDavTest(); }} autoComplete="current-password" /></label>
          <label className="check-field"><input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} /><span>包含子文件夹</span></label>
        </>}
        {type === 'direct' && <fieldset className="direct-fields"><legend>在线图片</legend>
          {directRows.map((row, index) => <div className="direct-row" key={row.rowKey}>
            <label className="field"><span>图片 URL {index + 1}</span><input type="url" value={row.url} onChange={(event) => { const nextUrl = event.target.value; setDirectRows((rows) => rows.map((item) => item.id === row.id ? { ...item, id: nextUrl === item.url ? item.id : createId(), url: nextUrl } : item)); setTested(false); }} placeholder="https://example.com/photo.jpg" /></label>
            <label className="field"><span>标签 {index + 1}（可选）</span><input value={row.label ?? ''} onChange={(event) => setDirectRows((rows) => rows.map((item) => item.id === row.id ? { ...item, label: event.target.value } : item))} /></label>
            <button type="button" className="text-button text-button--with-icon" aria-label={`上移图片 ${index + 1}`} title="上移" disabled={index === 0} onClick={() => setDirectRows((rows) => moveRow(rows, index, index - 1))}><Icon name="arrow-up" /><span>上</span></button>
            <button type="button" className="text-button text-button--with-icon" aria-label={`下移图片 ${index + 1}`} title="下移" disabled={index === directRows.length - 1} onClick={() => setDirectRows((rows) => moveRow(rows, index, index + 1))}><Icon name="arrow-down" /><span>下</span></button>
            <button type="button" className="text-button text-button--with-icon text-button--danger" aria-label={`删除图片 ${index + 1}`} title="删除" disabled={directRows.length === 1} onClick={() => setDirectRows((rows) => rows.filter((item) => item.id !== row.id))}><Icon name="trash" /><span>删</span></button>
          </div>)}
          <button type="button" className="text-button text-button--with-icon" aria-label="添加图片" title="添加图片" onClick={() => setDirectRows((rows) => [...rows, { id: createId(), rowKey: createId(), url: '' }])}><Icon name="plus" /><span>添加</span></button>
        </fieldset>}
        {type === 'json-api' && <>
          <p className="credential-note">请求头会保存在当前浏览器配置中；这不是密码库，任何能解锁此浏览器个人资料的人都可能恢复其中的密钥。</p>
          <label className="field"><span>API 地址</span><input type="url" value={endpoint} onChange={(event) => { setEndpoint(event.target.value); setTested(false); }} placeholder="https://api.example.com/images" /></label>
          <fieldset className="header-fields"><legend>请求头</legend>
            {headerRows.map((row) => <div className="header-row" key={row.id}>
              <label className="field"><span>名称</span><input value={row.key} onChange={(event) => { setHeaderRows((rows) => rows.map((item) => item.id === row.id ? { ...item, key: event.target.value, revealed: false } : item)); setTested(false); }} /></label>
              <label className="field"><span>值</span><input aria-label={`${row.key || '请求头'} 值`} type={row.revealed ? 'text' : 'password'} value={row.value} autoComplete="off" onChange={(event) => { setHeaderRows((rows) => rows.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item)); setTested(false); }} /></label>
              <button type="button" className="text-button text-button--with-icon" aria-label={`${row.revealed ? '隐藏' : '显示'} ${row.key || '请求头'}`} title={row.revealed ? '隐藏' : '显示'} onClick={() => setHeaderRows((rows) => rows.map((item) => item.id === row.id ? { ...item, revealed: !item.revealed } : item))}>{row.revealed ? <Icon name="eye-off" /> : <Icon name="eye" />}<span>{row.revealed ? '隐藏' : '显示'}</span></button>
              <button type="button" className="text-button text-button--with-icon text-button--danger" aria-label={`删除请求头 ${row.key || ''}`} title="删除" onClick={() => setHeaderRows((rows) => rows.filter((item) => item.id !== row.id))}><Icon name="trash" /><span>删除</span></button>
            </div>)}
            <button type="button" className="text-button text-button--with-icon" aria-label="添加请求头" title="添加请求头" onClick={() => setHeaderRows((rows) => [...rows, { id: createId(), key: '', value: '', revealed: false }])}><Icon name="plus" /><span>添加</span></button>
          </fieldset>
          <label className="field"><span>图片数组路径</span><input value={arrayPath} onChange={(event) => setArrayPath(event.target.value)} placeholder="results" /></label>
          <label className="field"><span>图片 URL 字段</span><input value={imagePath} onChange={(event) => setImagePath(event.target.value)} placeholder="urls.full" /></label>
          <label className="field"><span>稳定 ID 字段（可选）</span><input value={stableIdPath} onChange={(event) => setStableIdPath(event.target.value)} placeholder="id" /></label>
          <label className="field"><span>标题字段（可选）</span><input value={titlePath} onChange={(event) => setTitlePath(event.target.value)} /></label>
          <label className="field"><span>作者字段（可选）</span><input value={authorPath} onChange={(event) => setAuthorPath(event.target.value)} /></label>
          <label className="field"><span>来源页面字段（可选）</span><input value={sourcePagePath} onChange={(event) => setSourcePagePath(event.target.value)} /></label>
          <label className="field"><span>宽度字段（可选）</span><input value={widthPath} onChange={(event) => setWidthPath(event.target.value)} /></label>
          <label className="field"><span>高度字段（可选）</span><input value={heightPath} onChange={(event) => setHeightPath(event.target.value)} /></label>
          <label className="field"><span>起始页</span><input type="number" min="1" value={startingPage} onChange={(event) => setStartingPage(Math.max(1, Number(event.target.value) || 1))} /></label>
          <label className="field"><span>分页参数（可选）</span><input value={pageParam} onChange={(event) => setPageParam(event.target.value)} /></label>
        </>}
        {type === 'tmdb' && <>
          <div className="provider-guide"><p>使用你的 TMDB API Read Token。密钥仅保存在本机。</p><div><a href={PROVIDERS.tmdb.applyUrl} target="_blank" rel="noopener noreferrer">申请 API Key</a><a href={PROVIDERS.tmdb.guideUrl} target="_blank" rel="noopener noreferrer">查看接入指南</a></div></div>
          <label className="field"><span>API Read Token</span><input type="password" value={tmdbToken} onChange={(event) => setTmdbToken(event.target.value)} autoComplete="off" /></label>
          <label className="field"><span>媒体类型</span><select value={tmdbMedia} onChange={(event) => setTmdbMedia(event.target.value as TmdbSourceConfig['media'])}><option value="movie">电影</option><option value="tv">电视节目</option></select></label>
          <label className="field"><span>内容分类</span><select value={tmdbFeed} onChange={(event) => setTmdbFeed(event.target.value)}>{feeds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="field"><span>官方分类</span><select value={tmdbGenre} disabled={!tested || !tmdbMetadata} onChange={(event) => chooseTmdbGenre(event.target.value)}><option value="">全部类型</option>{tmdbGenres.map((genre) => <option key={genre.id} value={genre.id}>{genre.name}</option>)}</select></label>
          <label className="field"><span>语言</span><select value={tmdbLanguage} disabled={!tested || !tmdbMetadata} onChange={(event) => setTmdbLanguage(event.target.value)}><option value="">默认语言</option>{tmdbLanguage && !tmdbLanguages.includes(tmdbLanguage) && <option value={tmdbLanguage}>{tmdbLanguage}</option>}{tmdbLanguages.map((language) => <option key={language} value={language}>{displayName(languageNames, language)}</option>)}</select></label>
          {tmdbMedia === 'movie' && <label className="field"><span>地区</span><select value={tmdbRegion} disabled={!tested || !tmdbMetadata} onChange={(event) => setTmdbRegion(event.target.value)}><option value="">全部地区</option>{tmdbRegion && !tmdbRegions.includes(tmdbRegion) && <option value={tmdbRegion}>{tmdbRegion}</option>}{tmdbRegions.map((region) => <option key={region} value={region}>{displayName(regionNames, region)}</option>)}</select></label>}
          {tmdbFeed === 'discover' && <>
            <label className="field"><span>{tmdbMedia === 'movie' ? '上映年份' : '首播年份'}</span><input type="number" min="1900" max="2100" value={tmdbYear} onChange={(event) => setTmdbYear(event.target.value)} /></label>
            <label className="field"><span>{tmdbMedia === 'movie' ? '上映日期从' : '首播日期从'}</span><input type="date" value={tmdbDateFrom} onChange={(event) => setTmdbDateFrom(event.target.value)} /></label>
            <label className="field"><span>{tmdbMedia === 'movie' ? '上映日期至' : '首播日期至'}</span><input type="date" value={tmdbDateTo} onChange={(event) => setTmdbDateTo(event.target.value)} /></label>
            <label className="field"><span>最低评分</span><input type="number" min="0" max="10" step="0.1" value={tmdbRating} onChange={(event) => setTmdbRating(event.target.value)} /></label>
            <label className="field"><span>排序</span><input value={tmdbSort} onChange={(event) => setTmdbSort(event.target.value)} placeholder="popularity.desc" /></label>
          </>}
          <label className="field"><span>结果页</span><input type="number" min="1" max="500" value={tmdbPage} onChange={(event) => setTmdbPage(Math.max(1, Math.min(500, Number(event.target.value) || 1)))} /></label>
        </>}
      </div>
      {localGallery}
      {type !== 'local' && type !== 'json-api' && <button className="button button--secondary button--with-icon" type="button" aria-label={busy ? '正在测试…' : '测试连接'} title={busy ? '正在测试…' : '测试连接'} onClick={() => void runTest()} disabled={busy}>{busy ? <Icon name="refresh" /> : <Icon name="test" />}<span>{busy ? '测试中' : '测试'}</span></button>}
      {type === 'json-api' && <div className="json-test-actions">
        <button className="button button--secondary button--with-icon" type="button" aria-label={busy && !jsonDiscovery ? '正在测试 API…' : '测试 API'} title={busy && !jsonDiscovery ? '正在测试 API…' : '测试 API'} onClick={() => void discoverJsonOrigins()} disabled={busy}>{busy && !jsonDiscovery ? <Icon name="refresh" /> : <Icon name="test" />}<span>{busy && !jsonDiscovery ? '测试中' : '测试'}</span></button>
        <button className="button button--with-icon" type="button" aria-label={busy && jsonDiscovery ? '正在完成预览…' : '授权图片域并完成预览'} title={busy && jsonDiscovery ? '正在完成预览…' : '授权图片域并完成预览'} onClick={() => void completeJsonPreview()} disabled={busy || !jsonDiscovery || jsonDiscovery.key !== jsonDiscoveryKey}>{busy && jsonDiscovery ? <Icon name="refresh" /> : <Icon name="check" />}<span>{busy && jsonDiscovery ? '预览中' : '预览'}</span></button>
        {jsonDiscovery && jsonDiscovery.key === jsonDiscoveryKey && <p className="json-origin-summary">{jsonDiscovery.origins.length ? `待授权图片域：${jsonDiscovery.origins.join('、')}` : '未发现独立图片域；仍需确认完成预览。'}</p>}
      </div>}
      {status && <p className={`form-message form-message--${status.kind}`} role={status.kind === 'error' ? 'alert' : 'status'}>{status.message}</p>}
      {previewList}
      <div className="editor-actions">
        {onDelete && <button className="text-button text-button--with-icon text-button--danger" type="button" aria-label="删除图片源" title="删除图片源" onClick={(event) => onDelete(event.currentTarget)}><Icon name="trash" /><span>删除</span></button>}
        <button className="button button--with-icon" type="button" aria-label="保存并使用" title="保存并使用" onClick={() => void save()} disabled={busy}><Icon name="save" /><span>保存</span></button>
      </div>
    </section>
    {webDavPickerDialog}
    </>
  );
}

function ThumbnailImage({ src, alt, title }: { src: string; alt: string; title?: string }) {
  const [loading, setLoading] = useState(true);
  return <span className="source-preview__item" aria-busy={loading}>
    {loading && <span className="source-preview__image-loading" role="progressbar" aria-label="缩略图加载中"><span aria-hidden="true" /></span>}
    <img className={loading ? 'is-loading' : ''} src={src} alt={alt} title={title} loading="lazy" decoding="async" onLoad={() => setLoading(false)} onError={() => setLoading(false)} />
  </span>;
}

function displayNames(locale: string, type: 'language' | 'region'): Intl.DisplayNames | undefined {
  try { return new Intl.DisplayNames(locale, { type }); }
  catch { return undefined; }
}

function displayName(names: Intl.DisplayNames | undefined, code: string): string {
  const name = names?.of(code);
  return name && name !== code ? `${name} (${code})` : code;
}

export function permissionTargetsForSource(source: SourceConfig): string[] {
  if (source.type === 'webdav') return [source.url];
  if (source.type === 'json-api') return [source.endpoint, ...source.authorizedImageOrigins];
  if (source.type === 'tmdb') return [];
  if (source.type !== 'direct') return [];
  const origins = new Set<string>();
  const targets: string[] = [];
  for (const entry of source.entries) {
    try {
      const origin = new URL(entry.url).origin;
      if (!origins.has(origin)) { origins.add(origin); targets.push(entry.url); }
    } catch { /* adapter validation will provide the field error */ }
  }
  return targets;
}

function SourceConfigSummary({ source }: { source: SourceConfig }) {
  const rows = sourceSummaryRows(source);
  return <dl className="source-summary" aria-label="图片源配置摘要">
    {rows.map((row) => <div key={row.label} className="source-summary__row"><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
  </dl>;
}

function sourceSummaryRows(source: SourceConfig): { label: string; value: string }[] {
  if (source.type === 'webdav') return [
    { label: 'WebDAV 地址', value: summarizeUrlHost(source.url) },
    { label: '目标文件夹', value: source.folderPath?.length ? `/${source.folderPath.join('/')}` : '/' },
    { label: '用户名', value: source.username || '未填写' },
    { label: '密码', value: source.password ? '已保存' : '未填写' },
    { label: '子文件夹', value: source.includeSubdirectories ? '包含' : '不包含' }
  ];
  if (source.type === 'direct') return [
    { label: '图片 URL', value: `${source.entries.length} 条` }
  ];
  if (source.type === 'json-api') return [
    { label: 'API 地址', value: summarizeUrlHost(source.endpoint) },
    { label: '请求头', value: `${Object.keys(source.headers).length} 个，敏感值已隐藏` },
    { label: '图片域', value: source.authorizedImageOrigins.length ? `${source.authorizedImageOrigins.length} 个已授权` : '跟随 API 地址' }
  ];
  if (source.type === 'tmdb') return [
    { label: '媒体类型', value: source.media === 'movie' ? '电影' : '电视节目' },
    { label: '内容分类', value: source.feed },
    { label: 'API Token', value: source.token ? '已保存' : '未填写' }
  ];
  return [
    { label: '存储位置', value: '当前浏览器' },
    { label: '子文件夹', value: source.includeSubdirectories ? '包含' : '不包含' }
  ];
}

function summarizeUrlHost(value: string): string {
  try { return new URL(value).host; }
  catch { return value || '未填写'; }
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `source-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function setOrDelete(target: Record<string, string | number | boolean | undefined>, key: string, value: string | number): void {
  if (value === '') delete target[key];
  else target[key] = value;
}

function moveRow<T>(rows: readonly T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= rows.length || to >= rows.length || from === to) return [...rows];
  const next = [...rows]; const [item] = next.splice(from, 1); if (item !== undefined) next.splice(to, 0, item); return next;
}

export function buildWebDavDirectoryUrl(baseValue: string, relativeSegments: readonly string[]): string | undefined {
  return canonicalWebDavChildDirectory(baseValue, relativeSegments);
}

export function sourceTypeName(type: SourceType): string {
  return ({ local: '本地图片', webdav: 'WebDAV', direct: '在线图片 URL', 'json-api': 'JSON API', tmdb: 'TMDB' })[type];
}
