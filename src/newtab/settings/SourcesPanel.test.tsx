import { useRef, useState } from 'react';
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultSettings } from '../../domain/defaults';
import type { NewPicTabSettings, SourceConfig } from '../../domain/types';
import type { ConnectionTestResult, ImageEntry, ListImagesResult } from '../../sources/adapter';
import { LocalSourceAdapter } from '../../sources/local';
import { listLocal, listPendingLocalCleanups, putLocal } from '../../storage/imageDb';
import { createSourceOperations } from '../sourceClient';
import { SourcesPanel, type SourceOperations } from './SourcesPanel';

afterEach(cleanup);

function sourceOperations(overrides: Partial<SourceOperations> = {}): SourceOperations {
  return {
    test: vi.fn(async (): Promise<ConnectionTestResult> => ({ ok: true, entries: [] })),
    importLocal: vi.fn(async (_sourceId: string, files: File[]) => ({ imported: files.length, failures: [] })),
    delete: vi.fn(async () => undefined),
    loadTmdbMetadata: vi.fn(async () => ({ ok: true as const, genres: [{ id: 28, name: '动作' }], languages: ['en-US', 'zh-CN'], regions: ['CN', 'US'] })),
    withOriginPermissions: vi.fn(async (_urls, operation) => ({ ok: true as const, value: await operation() })),
    ...overrides
  };
}

function Harness({ initial = createDefaultSettings(), operations, counts = {}, onRefresh = vi.fn(), onSettings }: { initial?: NewPicTabSettings; operations: SourceOperations; counts?: Record<string, number | undefined>; onRefresh?: (sourceId: string) => void | Promise<void>; onSettings?: (settings: NewPicTabSettings) => void }) {
  const [settings, setSettings] = useState(initial);
  const current = useRef(initial);
  return <SourcesPanel settings={settings} operations={operations} counts={counts} onUpdate={async (updater) => {
    current.current = updater(current.current);
    onSettings?.(current.current);
    setSettings(current.current);
    return current.current;
  }} onRefresh={onRefresh} />;
}

async function removeImageDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('newpictab');
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('test database remained open'));
  });
}

describe('SourcesPanel', () => {
  it('commits a new local source before refresh and never rolls it back when refresh rejects', async () => {
    await removeImageDatabase();
    const adapter = new LocalSourceAdapter({ createObjectURL: () => 'blob:committed' });
    const operations = createSourceOperations(adapter);
    let latest = createDefaultSettings();
    const refresh = vi.fn(async () => { throw new Error('private refresh failure'); });
    render(<Harness operations={operations} onRefresh={refresh} onSettings={(settings) => { latest = settings; }} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '添加图片源' }));
    await user.click(screen.getByRole('button', { name: '本地图片' }));
    await user.type(screen.getByLabelText('图片源名称'), 'Committed local');
    await user.upload(screen.getByLabelText('导入本地图片'), new File(['image'], 'image.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: '保存并使用' }));

    await waitFor(() => expect(screen.getByText('Committed local')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('已保存，但刷新失败'));
    const saved = latest.sources.find((source) => source.name === 'Committed local')!;
    expect(latest.activeSourceId).toBe(saved.id);
    expect(await listLocal(saved.id)).toHaveLength(1);
    await expect(adapter.listImages(saved as Extract<SourceConfig, { type: 'local' }>)).resolves.toMatchObject({ ok: true, images: [{ sourceId: saved.id }] });
    cleanup(); await removeImageDatabase();
  });

  it('keeps an existing local config and blobs when durable settings removal rejects', async () => {
    await removeImageDatabase();
    const source: Extract<SourceConfig, { type: 'local' }> = { id: 'local-settings-reject', type: 'local', name: 'Keep local', enabled: true, createdAt: 1, updatedAt: 1, includeSubdirectories: false };
    const deleteStorage = vi.fn(async () => undefined);
    const adapter = new LocalSourceAdapter({}, { listLocal, putLocal, deleteSource: deleteStorage });
    const realOperations = createSourceOperations(adapter);
    await realOperations.importLocal(source.id, [new File(['keep'], 'keep.jpg', { type: 'image/jpeg' })]);
    const deleteCommittedLocal = vi.fn(realOperations.deleteCommittedLocal);
    const operations = { ...realOperations, deleteCommittedLocal };
    render(<SourcesPanel settings={{ ...createDefaultSettings(), sources: [source], activeSourceId: source.id }} operations={operations} counts={{}} onUpdate={vi.fn(async () => { throw new Error('private settings failure'); })} onRefresh={vi.fn()} />);
    const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: '删除 Keep local' })); await user.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('删除失败'));
    expect(deleteCommittedLocal).toHaveBeenCalledOnce();
    expect(deleteStorage).not.toHaveBeenCalled();
    expect(screen.getByText('Keep local')).toBeInTheDocument();
    expect(await listLocal(source.id)).toHaveLength(1);
    expect(await listPendingLocalCleanups()).not.toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: source.id })]));
    cleanup(); await removeImageDatabase();
  });
  it('keeps a source loading error inside its settings card', () => {
    const source: SourceConfig = { id: 'remote-1', type: 'direct', name: '远端图库', enabled: true, createdAt: 1, updatedAt: 1, entries: [] };
    const settings = { ...createDefaultSettings(), activeSourceId: source.id, sources: [source] };
    render(<SourcesPanel settings={settings} operations={sourceOperations()} counts={{}} states={{ [source.id]: { status: 'error', message: '无法载入图片。' } }} onUpdate={vi.fn()} onRefresh={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent('无法载入图片');
  });

  it('labels cached stale content instead of claiming the source is ready', () => {
    const source: SourceConfig = { id: 'stale', type: 'direct', name: '缓存图库', enabled: true, createdAt: 1, updatedAt: 1, entries: [] };
    render(<SourcesPanel settings={{ ...createDefaultSettings(), sources: [source] }} operations={sourceOperations()} counts={{ stale: 500 }} states={{ stale: { status: 'stale', message: '刷新失败，正在使用缓存。' } }} onUpdate={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('刷新失败，正在使用缓存'); expect(screen.queryByText('连接正常。')).not.toBeInTheDocument(); expect(screen.getByText(/500 张图片/)).toBeInTheDocument();
  });

  it('shows source availability in the top-right badge area of each source item', () => {
    const ready: SourceConfig = { id: 'ready', type: 'direct', name: '可用图库', enabled: true, createdAt: 1, updatedAt: 1, entries: [] };
    const failed: SourceConfig = { id: 'failed', type: 'direct', name: '失效图库', enabled: true, createdAt: 1, updatedAt: 1, entries: [] };
    const disabled: SourceConfig = { id: 'disabled', type: 'direct', name: '停用图库', enabled: false, createdAt: 1, updatedAt: 1, entries: [] };
    render(<SourcesPanel settings={{ ...createDefaultSettings(), sources: [ready, failed, disabled], activeSourceId: ready.id }} operations={sourceOperations()} counts={{}} states={{ ready: { status: 'ready' }, failed: { status: 'error' } }} onUpdate={vi.fn()} onRefresh={vi.fn()} />);

    const readyBadges = screen.getByText('可用图库').closest('article')?.querySelector<HTMLElement>('.source-card__badges');
    const failedBadges = screen.getByText('失效图库').closest('article')?.querySelector<HTMLElement>('.source-card__badges');
    const disabledBadges = screen.getByText('停用图库').closest('article')?.querySelector<HTMLElement>('.source-card__badges');
    expect(readyBadges).not.toBeNull();
    expect(within(readyBadges!).getByLabelText('图片源状态：可用')).toHaveTextContent('可用');
    expect(within(readyBadges!).getByText('正在使用')).toBeInTheDocument();
    expect(within(failedBadges!).getByLabelText('图片源状态：不可用')).toHaveTextContent('不可用');
    expect(within(disabledBadges!).getByLabelText('图片源状态：已停用')).toHaveTextContent('已停用');
  });

  it('shows a successful connection message only once after testing an already-ready source', async () => {
    const source: SourceConfig = { id: 'ready', type: 'direct', name: '可用图库', enabled: true, createdAt: 1, updatedAt: 1, entries: [] };
    const user = userEvent.setup();
    render(<SourcesPanel settings={{ ...createDefaultSettings(), sources: [source] }} operations={sourceOperations()} counts={{}} states={{ ready: { status: 'ready' } }} onUpdate={vi.fn()} onRefresh={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '测试 可用图库' }));

    await waitFor(() => expect(screen.getAllByText('连接正常。')).toHaveLength(1));
  });

  it('offers complete source-card actions and surfaces cache failures without deleting config', async () => {
    const source: SourceConfig = { id: 'remote-1', type: 'direct', name: '远端图库', enabled: true, createdAt: 1, updatedAt: 1, entries: [{ id: 'a', url: 'https://images.example/a.jpg' }] };
    const settings = { ...createDefaultSettings(), sources: [source] };
    const clearCache = vi.fn(async () => { throw new Error('safe cache error'); });
    const user = userEvent.setup();
    render(<SourcesPanel settings={settings} operations={sourceOperations({ refresh: vi.fn(async () => undefined), clearCache })} counts={{}} onUpdate={vi.fn()} onRefresh={vi.fn()} />);

    for (const name of ['使用此源', '重命名 远端图库', '编辑配置 远端图库', '测试 远端图库', '刷新 远端图库', '清除缓存 远端图库', '删除 远端图库']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '清除缓存 远端图库' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('无法清除缓存'));
    expect(screen.getByText('远端图库')).toBeInTheDocument();
  });

  it('opens saved WebDAV configuration as a preview-first management view and reveals full fields only from edit', async () => {
    const source: SourceConfig = { id: 'webdav-manage', type: 'webdav', name: '家庭 WebDAV', enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example/photos/', folderPath: ['Family'], username: 'alice', password: 'secret-password', includeSubdirectories: false };
    const settings = { ...createDefaultSettings(), sources: [source], activeSourceId: source.id };
    const cached = [{ id: 'one', sourceId: source.id, remoteCacheEntryId: 'one', remoteCacheFingerprint: 'fingerprint' }] as [{ id: string; sourceId: string; remoteCacheEntryId: string; remoteCacheFingerprint: string }];
    const release = vi.fn();
    const operations = sourceOperations({
      list: vi.fn(async () => ({ ok: true as const, images: cached })),
      materializePreview: vi.fn(async () => ({ entries: [{ id: 'one', sourceId: source.id, url: 'blob:webdav-manage' }], release, released: false } as unknown as import('../sourceClient').RemoteCacheLease))
    });
    const user = userEvent.setup();
    render(<Harness initial={settings} operations={operations} counts={{ [source.id]: 12 }} />);

    await user.click(screen.getByRole('button', { name: '编辑配置 家庭 WebDAV' }));

    expect(screen.getByRole('heading', { name: '管理 WebDAV' })).toBeInTheDocument();
    expect(screen.getByText('WebDAV 地址')).toBeInTheDocument();
    expect(screen.getByText('dav.example')).toBeInTheDocument();
    expect(screen.getByText('用户名')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('密码')).toBeInTheDocument();
    expect(screen.getByText('已保存')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '修改目标文件夹' })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: '图片预览缩略图' })).toHaveAttribute('src', 'blob:webdav-manage');
    expect(screen.queryByLabelText('WebDAV 地址')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('secret-password')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '编辑完整配置' }));

    expect(screen.getByLabelText('WebDAV 地址')).toHaveValue(source.url);
    expect(screen.getByLabelText('用户名')).toHaveValue(source.username);
    expect(screen.getByLabelText('密码')).toHaveValue(source.password);
  });

  it('loads saved source preview thumbnails one page at a time while scrolling', async () => {
    const source: SourceConfig = { id: 'direct-manage-preview', type: 'direct', name: '滚动图库', enabled: true, createdAt: 1, updatedAt: 1, entries: [] };
    const settings = { ...createDefaultSettings(), sources: [source], activeSourceId: source.id };
    const pages = [
      Array.from({ length: 6 }, (_, index) => ({ id: `page-1-${index}`, sourceId: source.id, remoteCacheEntryId: `page-1-${index}`, remoteCacheFingerprint: 'fingerprint' })) as [ImageEntry, ...ImageEntry[]],
      Array.from({ length: 3 }, (_, index) => ({ id: `page-2-${index}`, sourceId: source.id, remoteCacheEntryId: `page-2-${index}`, remoteCacheFingerprint: 'fingerprint' })) as [ImageEntry, ...ImageEntry[]]
    ] as const;
    let resolveSecondList!: (value: Awaited<ReturnType<NonNullable<SourceOperations['list']>>>) => void;
    const operations = sourceOperations({
      list: vi.fn(async (_source: SourceConfig, options?: { offset?: number; limit?: number }): Promise<ListImagesResult> => {
        if (options?.offset === 6) return new Promise<ListImagesResult>((resolve) => { resolveSecondList = resolve; });
        return { ok: true as const, images: pages[0], offset: 0, nextOffset: 6, hasMore: true, totalCount: 9 };
      }),
      materializePreview: vi.fn(async (entries: readonly ImageEntry[]) => ({ entries: entries.map((entry) => ({ id: entry.id, sourceId: entry.sourceId, url: `blob:${entry.id}` })), release: vi.fn(), released: false } as unknown as import('../sourceClient').RemoteCacheLease))
    });
    const user = userEvent.setup();
    render(<Harness initial={settings} operations={operations} counts={{ [source.id]: 9 }} />);

    await user.click(screen.getByRole('button', { name: '编辑配置 滚动图库' }));
    const firstImage = (await screen.findAllByRole('img', { name: '图片预览缩略图' }))[0]!;
    expect(firstImage).toHaveAttribute('src', 'blob:page-1-0');
    expect(firstImage).toHaveAttribute('loading', 'lazy');
    expect(firstImage).toHaveAttribute('decoding', 'async');
    expect(operations.list).toHaveBeenCalledWith(source, { offset: 0, limit: 6 });
    expect(operations.materializePreview).toHaveBeenCalledWith(pages[0]);
    expect(screen.getAllByRole('img', { name: '图片预览缩略图' })).toHaveLength(6);

    fireEvent.scroll(screen.getByLabelText('连接预览'), { currentTarget: { scrollTop: 500, scrollHeight: 600, clientHeight: 120 } });

    expect(await screen.findByText('正在加载更多预览…')).toBeInTheDocument();
    expect(operations.list).toHaveBeenCalledWith(source, { offset: 6, limit: 6 });
    resolveSecondList({ ok: true as const, images: pages[1], offset: 6, nextOffset: 9, hasMore: false, totalCount: 9 });
    await waitFor(() => expect(screen.getAllByRole('img', { name: '图片预览缩略图' })).toHaveLength(9));
  });

  it('saves a changed WebDAV target folder from the management view', async () => {
    const source: SourceConfig = { id: 'webdav-folder-manage', type: 'webdav', name: '家庭 WebDAV', enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example/photos/', folderPath: ['Family'], username: 'alice', password: 'secret-password', includeSubdirectories: false };
    const settings = { ...createDefaultSettings(), sources: [source], activeSourceId: source.id };
    const test = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, protected: true as const, imageOrigins: ['https://dav.example/*'], count: 0, preview: [], directories: [{ id: `dir_${'a'.repeat(64)}`, name: 'Trips', relativeSegments: ['Trips'] }] })
      .mockResolvedValueOnce({ ok: true as const, protected: true as const, imageOrigins: ['https://dav.example/*'], count: 0, preview: [], directories: [] });
    const cached = [{ id: 'one', sourceId: source.id, remoteCacheEntryId: 'one', remoteCacheFingerprint: 'fingerprint' }] as [{ id: string; sourceId: string; remoteCacheEntryId: string; remoteCacheFingerprint: string }];
    const operations = sourceOperations({
      test,
      list: vi.fn(async () => ({ ok: true as const, images: cached })),
      materializePreview: vi.fn(async () => ({ entries: [{ id: 'one', sourceId: source.id, url: 'blob:webdav-folder-manage' }], release: vi.fn(), released: false } as unknown as import('../sourceClient').RemoteCacheLease))
    });
    let latest: NewPicTabSettings = settings;
    const user = userEvent.setup();
    render(<Harness initial={settings} operations={operations} counts={{ [source.id]: 1 }} onSettings={(next) => { latest = next; }} />);

    await user.click(screen.getByRole('button', { name: '编辑配置 家庭 WebDAV' }));
    await user.click(screen.getByRole('button', { name: '修改目标文件夹' }));
    expect(await screen.findByRole('dialog', { name: '选择 WebDAV 文件夹' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '打开文件夹 Trips' }));
    await user.click(screen.getByRole('button', { name: '确认选择' }));

    await waitFor(() => expect(latest.sources[0]).toMatchObject({ type: 'webdav', folderPath: ['Family', 'Trips'] }));
    expect(screen.queryByRole('dialog', { name: '选择 WebDAV 文件夹' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('目标文件夹已更新');
  });

  it('adds multiple sources of the same type and activates the saved source immediately', async () => {
    const user = userEvent.setup();
    render(<Harness operations={sourceOperations()} />);

    for (const name of ['第一组', '第二组']) {
      await user.click(screen.getByRole('button', { name: '添加图片源' }));
      await user.click(screen.getByRole('button', { name: '本地图片' }));
      await user.clear(screen.getByLabelText('图片源名称'));
      await user.type(screen.getByLabelText('图片源名称'), name);
      await user.upload(screen.getByLabelText('导入本地图片'), new File([name], `${name}.jpg`, { type: 'image/jpeg' }));
      await user.click(screen.getByRole('button', { name: '保存并使用' }));
    }

    expect(screen.getByText('第一组')).toBeInTheDocument();
    const second = screen.getByText('第二组').closest('article')!;
    expect(within(second).getByText('正在使用')).toBeInTheDocument();
    expect(screen.getAllByText('本地图片')).toHaveLength(2);
  });

  it('requests exact-origin permission from the test click before a WebDAV request', async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    const operations = sourceOperations({
      withOriginPermissions: vi.fn(async (_urls, operation) => {
        order.push('permission');
        return { ok: true as const, value: await operation() };
      }),
      test: vi.fn(async () => {
        order.push('request');
        return { ok: true as const, protected: true as const, imageOrigins: ['https://dav.example.com/*'], count: 0, preview: [] };
      })
    });
    render(<Harness operations={operations} />);

    await user.click(screen.getByRole('button', { name: '添加图片源' }));
    await user.click(screen.getByRole('button', { name: 'WebDAV' }));
    await user.type(screen.getByLabelText('图片源名称'), '家庭相册');
    await user.type(screen.getByLabelText('WebDAV 地址'), 'https://dav.example.com/photos/');
    await user.type(screen.getByLabelText('用户名'), 'alice');
    await user.type(screen.getByLabelText('密码'), 'not-shown');
    await user.click(screen.getByRole('button', { name: '测试连接' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('连接成功'));
    expect(order).toEqual(['permission', 'request']);
  });

  it('does not send a WebDAV request when optional permission is denied', async () => {
    const user = userEvent.setup();
    const test = vi.fn();
    const operations = sourceOperations({
      test,
      withOriginPermissions: vi.fn(async () => ({ ok: false as const, error: { code: 'permission-denied' as const, message: '未授予访问权限。' } }))
    });
    render(<Harness operations={operations} />);

    await user.click(screen.getByRole('button', { name: '添加图片源' }));
    await user.click(screen.getByRole('button', { name: 'WebDAV' }));
    await user.type(screen.getByLabelText('图片源名称'), '家庭相册');
    await user.type(screen.getByLabelText('WebDAV 地址'), 'https://dav.example.com/photos/');
    await user.type(screen.getByLabelText('用户名'), 'alice');
    await user.type(screen.getByLabelText('密码'), 'secret');
    await user.click(screen.getByRole('button', { name: '测试连接' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('未授予访问权限'));
    expect(test).not.toHaveBeenCalled();
  });

  it('requests every distinct direct-image origin before probing any image', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const operations = sourceOperations({
      withOriginPermissions: vi.fn(async (urls: string[], operation) => {
        calls.push(urls.map((url) => new URL(url).origin).join(','));
        return { ok: true as const, value: await operation() };
      }),
      test: vi.fn(async () => { calls.push('request'); return { ok: true as const, entries: [] }; })
    });
    render(<Harness operations={operations} />);

    await user.click(screen.getByRole('button', { name: '添加图片源' }));
    await user.click(screen.getByRole('button', { name: '在线图片 URL' }));
    await user.type(screen.getByLabelText('图片源名称'), '网络收藏');
    await user.type(screen.getByLabelText('图片 URL 1'), 'https://one.example/a.jpg');
    await user.click(screen.getByRole('button', { name: '添加图片' }));
    await user.type(screen.getByLabelText('图片 URL 2'), 'https://two.example/b.jpg');
    await user.click(screen.getByRole('button', { name: '添加图片' }));
    await user.type(screen.getByLabelText('图片 URL 3'), 'https://one.example/c.jpg');
    await user.click(screen.getByRole('button', { name: '测试连接' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('连接成功'));
    expect(calls).toEqual(['https://one.example,https://two.example', 'request']);
  });

  it('imports several local images and names the destructive impact before deletion', async () => {
    const source: SourceConfig = { id: 'local-1', type: 'local', name: '本地收藏', enabled: true, createdAt: 1, updatedAt: 1, includeSubdirectories: false };
    const settings = { ...createDefaultSettings(), activeSourceId: source.id, sources: [source] };
    const operations = sourceOperations({ importLocal: vi.fn(async () => ({ imported: 2, failures: [] })) });
    const user = userEvent.setup();
    render(<Harness initial={settings} operations={operations} />);

    await user.click(screen.getByRole('button', { name: '编辑配置 本地收藏' }));
    const files = [new File(['a'], 'a.jpg', { type: 'image/jpeg' }), new File(['b'], 'b.png', { type: 'image/png' })];
    await user.upload(screen.getByLabelText('导入本地图片'), files);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已导入 2 张图片'));
    expect(operations.importLocal).toHaveBeenCalledWith('local-1', files);
    await user.click(screen.getByRole('button', { name: '删除图片源' }));

    expect(screen.getByRole('alertdialog', { name: '删除本地收藏' })).toHaveTextContent('永久删除保存在浏览器中的本地图片');
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(operations.delete).toHaveBeenCalledWith(source));
    expect(screen.queryByText('本地收藏')).not.toBeInTheDocument();
  });

  it('isolates the delete alertdialog, traps focus, and Escape restores the delete trigger', async () => {
    const source: SourceConfig = { id: 'direct-delete', type: 'direct', name: '待删除', enabled: true, createdAt: 1, updatedAt: 1, entries: [{ id: 'a', url: 'https://images.example/a.jpg' }] };
    const settings = { ...createDefaultSettings(), sources: [source] };
    const user = userEvent.setup();
    render(<Harness initial={settings} operations={sourceOperations()} />);
    const trigger = screen.getByRole('button', { name: '删除 待删除' });
    await user.click(trigger);

    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    const isolated = document.querySelector<HTMLElement>('[aria-hidden="true"]');
    expect(isolated).not.toBeNull();
    expect(isolated?.contains(trigger)).toBe(true);
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(screen.getByRole('button', { name: '确认删除' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('keeps source configuration and offers retry after asynchronous deletion fails', async () => {
    const source: SourceConfig = { id: 'delete-fail', type: 'direct', name: '保留我', enabled: true, createdAt: 1, updatedAt: 1, entries: [{ id: 'a', url: 'https://images.example/a.jpg' }] };
    const settings = { ...createDefaultSettings(), sources: [source] };
    const user = userEvent.setup();
    render(<Harness initial={settings} operations={sourceOperations({ delete: vi.fn(async () => { throw new Error('private'); }) })} />);
    await user.click(screen.getByRole('button', { name: '删除 保留我' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('删除失败'));
    expect(screen.getByText('保留我')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认删除' })).toBeEnabled();
  });

  it('keeps TMDB metadata options locked until connection succeeds and then shows official choices', async () => {
    const user = userEvent.setup();
    const operations = sourceOperations();
    render(<Harness operations={operations} />);

    await user.click(screen.getByRole('button', { name: '添加图片源' }));
    await user.click(screen.getByRole('button', { name: 'TMDB' }));
    expect(screen.getByRole('link', { name: '申请 API Key' })).toHaveAttribute('href', 'https://www.themoviedb.org/settings/api');
    expect(screen.getByRole('link', { name: '查看接入指南' })).toHaveAttribute('href', 'https://developer.themoviedb.org/v4/docs/getting-started');
    expect(screen.getByLabelText('官方分类')).toBeDisabled();
    expect(screen.getByLabelText('语言')).toBeDisabled();
    expect(screen.getByLabelText('地区')).toBeDisabled();

    await user.type(screen.getByLabelText('图片源名称'), '电影背景');
    await user.type(screen.getByLabelText('API Read Token'), 'private-token');
    await user.click(screen.getByRole('button', { name: '测试连接' }));

    await waitFor(() => expect(screen.getByLabelText('官方分类')).toBeEnabled());
    expect(screen.getByRole('option', { name: '动作' })).toBeInTheDocument();
    expect(screen.getByLabelText('语言')).toBeEnabled();
    expect(screen.getByLabelText('地区')).toBeEnabled();
    expect(within(screen.getByLabelText('语言')).getByRole('option', { name: /中文.*zh-CN/ })).toBeInTheDocument();
    expect(within(screen.getByLabelText('地区')).getByRole('option', { name: /中国.*CN/ })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('private-token');
  });
});
