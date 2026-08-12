import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JsonApiSourceConfig, SourceConfig, TmdbSourceConfig } from '../../domain/types';
import type { ImageEntry } from '../../sources/adapter';
import { LocalSourceAdapter } from '../../sources/local';
import { listLocal, putLocal } from '../../storage/imageDb';
import { createSourceOperations } from '../sourceClient';
import type { RemoteCacheLease } from '../sourceClient';
import type { OriginPermissionOperationResult } from '../../lib/permissions';
import { buildWebDavDirectoryUrl, permissionTargetsForSource, SourceEditor } from './SourceEditor';
import type { SourceOperations, TmdbMetadataResult } from './SourcesPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function removeImageDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('newpictab');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('test database remained open'));
  });
}

const operations: SourceOperations = {
  test: vi.fn(async () => ({ ok: true as const })),
  importLocal: vi.fn(async () => ({ imported: 0, failures: [] })),
  delete: vi.fn(async () => undefined),
  loadTmdbMetadata: vi.fn(async () => ({ ok: true as const, genres: [{ id: 28, name: 'Action' }], languages: ['en-US', 'zh-CN'], regions: ['CN', 'US'] })),
  withOriginPermissions: vi.fn(async (_urls, operation) => ({ ok: true as const, value: await operation() }))
};

async function saveUnchanged(source: SourceConfig): Promise<SourceConfig> {
  const user = userEvent.setup();
  let saved: SourceConfig | undefined;
  const onSave = vi.fn(async (value: SourceConfig) => { saved = value; });
  render(<SourceEditor source={source} type={source.type} operations={operations} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);
  if (source.type === 'tmdb') await user.click(screen.getByRole('button', { name: '测试连接' }));
  await user.click(screen.getByRole('button', { name: '保存并使用' }));
  return saved!;
}

describe('SourceEditor lossless editing', () => {
  it('rejects encoded and double-encoded traversal when building a WebDAV child URL', () => {
    expect(buildWebDavDirectoryUrl('https://dav.example/photos/', ['%2e%2e'])).toBeUndefined();
    expect(buildWebDavDirectoryUrl('https://dav.example/photos/', ['%252e%252e%252fsecret'])).toBeUndefined();
    expect(buildWebDavDirectoryUrl('https://dav.example/photos/', ['slash%2Fname'])).toBeUndefined();
  });

  it('builds canonical root WebDAV directory URLs without a double slash', () => {
    expect(buildWebDavDirectoryUrl('https://dav.example/', [])).toBe('https://dav.example/');
    expect(buildWebDavDirectoryUrl('https://dav.example/', ['Family'])).toBe('https://dav.example/Family/');
  });

  it('rejects WebDAV query and fragment capabilities while preserving port, Unicode, and long base segments', () => {
    const longSegment = 'a'.repeat(240);
    expect(buildWebDavDirectoryUrl('https://dav.example/photos?capability=secret', [])).toBeUndefined();
    expect(buildWebDavDirectoryUrl('https://dav.example/photos#album', [])).toBeUndefined();
    expect(buildWebDavDirectoryUrl(`https://dav.example:8443/相册/${longSegment}`, ['家庭 相册']))
      .toBe(`https://dav.example:8443/%E7%9B%B8%E5%86%8C/${longSegment}/%E5%AE%B6%E5%BA%AD%20%E7%9B%B8%E5%86%8C/`);
  });

  it('rejects a WebDAV capability query in the editor before permission or network work without rewriting it', async () => {
    const source: SourceConfig = { id: 'webdav-query', name: 'WebDAV', type: 'webdav', enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example/photos?capability=secret', username: 'user', password: 'secret', includeSubdirectories: false };
    const test = vi.fn(async () => ({ ok: true as const }));
    const permissionRequest = vi.fn();
    const withOriginPermissions: SourceOperations['withOriginPermissions'] = async <T,>(urls: string[], operation: () => Promise<T>) => {
      permissionRequest(urls);
      return operations.withOriginPermissions(urls, operation);
    };
    render(<SourceEditor source={source} type="webdav" operations={{ ...operations, test, withOriginPermissions }} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);

    await userEvent.setup().click(screen.getByRole('button', { name: '测试连接' }));

    expect(screen.getByRole('alert')).toHaveTextContent('不支持查询参数或片段');
    expect(screen.getByLabelText('WebDAV 地址')).toHaveValue(source.url);
    expect(permissionRequest).not.toHaveBeenCalled();
    expect(test).not.toHaveBeenCalled();
  });

  it('shows a per-image loading placeholder until a preview thumbnail finishes decoding', async () => {
    const source: SourceConfig = { id: 'direct-loading', name: 'Direct', type: 'direct', enabled: true, createdAt: 1, updatedAt: 1, entries: [{ id: 'one', url: 'https://private.example/one.jpg' }] };
    const cached = [{ id: 'one', sourceId: source.id, remoteCacheEntryId: 'one', remoteCacheFingerprint: 'fingerprint' }] as [{ id: string; sourceId: string; remoteCacheEntryId: string; remoteCacheFingerprint: string }];
    const custom: SourceOperations = {
      ...operations,
      test: vi.fn(async () => ({ ok: true as const, entries: [{ id: 'one', sourceId: source.id, url: source.entries[0]!.url }] })),
      list: vi.fn(async () => ({ ok: true as const, images: cached })),
      materializePreview: vi.fn(async () => ({ entries: [{ id: 'one', sourceId: source.id, url: 'blob:thumb' }], release: vi.fn(), released: false } as unknown as RemoteCacheLease))
    };
    render(<SourceEditor source={source} type="direct" operations={custom} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);

    await userEvent.setup().click(screen.getByRole('button', { name: '测试连接' }));
    const image = await screen.findByRole('img', { name: '图片预览缩略图' });
    expect(screen.getByRole('progressbar', { name: '缩略图加载中' })).toBeInTheDocument();
    expect(image.closest('.source-preview__item')).toHaveAttribute('aria-busy', 'true');

    fireEvent.load(image);

    expect(screen.queryByRole('progressbar', { name: '缩略图加载中' })).not.toBeInTheDocument();
    expect(image.closest('.source-preview__item')).toHaveAttribute('aria-busy', 'false');
  });

  it('materializes Direct test previews from the remote cache instead of rendering raw HTTPS URLs', async () => {
    const source: SourceConfig = { id: 'direct-preview', name: 'Direct', type: 'direct', enabled: true, createdAt: 1, updatedAt: 1, entries: [{ id: 'one', url: 'https://private.example/album/one.jpg' }] };
    const release = vi.fn();
    const cached = [{ id: 'one', sourceId: source.id, remoteCacheEntryId: 'one', remoteCacheFingerprint: 'fingerprint' }] as [{ id: string; sourceId: string; remoteCacheEntryId: string; remoteCacheFingerprint: string }];
    const custom: SourceOperations = {
      ...operations,
      test: vi.fn(async () => ({ ok: true as const, entries: [{ id: 'one', sourceId: source.id, url: source.entries[0]!.url }] })),
      list: vi.fn(async () => ({ ok: true as const, images: cached })),
      materializePreview: vi.fn(async () => ({ entries: [{ id: 'one', sourceId: source.id, url: 'blob:direct-preview' }], release, released: false } as unknown as RemoteCacheLease))
    };
    const view = render(<SourceEditor source={source} type="direct" operations={custom} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);

    await userEvent.setup().click(screen.getByRole('button', { name: '测试连接' }));

    await waitFor(() => expect(screen.getByRole('img', { name: '图片预览缩略图' })).toHaveAttribute('src', 'blob:direct-preview'));
    expect(screen.getByRole('img', { name: '图片预览缩略图' })).not.toHaveAttribute('src', source.entries[0]!.url);
    expect(custom.list).toHaveBeenCalledWith(source, { offset: 0, limit: 6 });
    expect(custom.materializePreview).toHaveBeenCalledWith(cached);
    view.unmount(); expect(release).toHaveBeenCalledOnce();
  });

  it('opens a WebDAV folder picker and materializes previews only after confirmation', async () => {
    const source: SourceConfig = { id: 'webdav-connection', name: 'WebDAV', type: 'webdav', enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example/photos', username: 'user', password: 'secret', includeSubdirectories: false };
    const release = vi.fn();
    const cached = [{ id: 'one', sourceId: source.id, remoteCacheEntryId: 'one', remoteCacheFingerprint: 'fingerprint' }] as [{ id: string; sourceId: string; remoteCacheEntryId: string; remoteCacheFingerprint: string }];
    const custom: SourceOperations = {
      ...operations,
      test: vi.fn(async () => ({ ok: true as const, protected: true as const, imageOrigins: [], count: 0, preview: [] })),
      list: vi.fn(async () => ({ ok: true as const, images: cached })),
      materializePreview: vi.fn(async () => ({ entries: [{ id: 'one', sourceId: source.id, url: 'blob:webdav-preview' }], release, released: false } as unknown as RemoteCacheLease))
    };
    const view = render(<SourceEditor source={source} type="webdav" operations={custom} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);

    await userEvent.setup().click(screen.getByRole('button', { name: '测试连接' }));

    expect(await screen.findByRole('dialog', { name: '选择 WebDAV 文件夹' })).toBeInTheDocument();
    expect(custom.list).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button', { name: '确认选择' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '图片预览缩略图' })).toHaveAttribute('src', 'blob:webdav-preview'));
    expect(screen.getByRole('status')).toHaveTextContent('已预览 1 张图片');
    expect(screen.getByRole('button', { name: '测试连接' })).toBeEnabled();
    expect(custom.list).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://dav.example/photos/' }), { offset: 0, limit: 6 });
    expect(custom.materializePreview).toHaveBeenCalledWith(cached);
    view.unmount(); expect(release).toHaveBeenCalledOnce();
  });

  it('browses WebDAV folders in a dialog without listing images until the folder is confirmed', async () => {
    const source: SourceConfig = { id: 'webdav-folders', name: 'WebDAV', type: 'webdav', enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example/photos', username: 'user', password: 'secret', includeSubdirectories: false };
    const test = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, protected: true as const, imageOrigins: ['https://dav.example/*'], count: 0, preview: [], directories: [{ id: `dir_${'a'.repeat(64)}`, name: '家庭 相册', relativeSegments: ['家庭 相册'] }] })
      .mockResolvedValueOnce({ ok: true as const, protected: true as const, imageOrigins: ['https://dav.example/*'], count: 0, preview: [], directories: [{ id: `dir_${'b'.repeat(64)}`, name: '2026', relativeSegments: ['2026'] }] });
    const cached = [{ id: 'one', sourceId: source.id, remoteCacheEntryId: 'one', remoteCacheFingerprint: 'fingerprint' }] as [{ id: string; sourceId: string; remoteCacheEntryId: string; remoteCacheFingerprint: string }];
    const list = vi.fn(async () => ({ ok: true as const, images: cached }));
    const materializePreview = vi.fn(async () => ({ entries: [{ id: 'one', sourceId: source.id, url: 'blob:webdav-folder' }], release: vi.fn(), released: false } as unknown as RemoteCacheLease));
    const onSave = vi.fn(async () => undefined);
    render(<SourceEditor source={source} type="webdav" operations={{ ...operations, test, list, materializePreview }} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByRole('dialog', { name: '选择 WebDAV 文件夹' })).toBeInTheDocument();
    expect(screen.getByLabelText('WebDAV 文件夹层级')).toBeInTheDocument();
    expect(screen.queryByLabelText('目标文件夹')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '打开文件夹 家庭 相册' }));
    expect(screen.getByLabelText('WebDAV 地址')).toHaveValue('https://dav.example/photos');
    expect(await screen.findByRole('button', { name: '打开文件夹 2026' })).toBeInTheDocument();
    expect(test).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'https://dav.example/photos/', folderPath: ['家庭 相册'] }));
    expect(screen.getByText('当前路径：/家庭 相册')).toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
    expect(materializePreview).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认选择' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '图片预览缩略图' })).toHaveAttribute('src', 'blob:webdav-folder'));
    expect(screen.queryByRole('dialog', { name: '选择 WebDAV 文件夹' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('WebDAV 地址')).toHaveValue('https://dav.example/photos');
    expect(list).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://dav.example/photos/', folderPath: ['家庭 相册'] }), { offset: 0, limit: 6 });

    await user.click(screen.getByRole('button', { name: '保存并使用' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://dav.example/photos/', folderPath: ['家庭 相册'] }));
  });

  it('lets an existing WebDAV source load more previews when the first six do not overflow', async () => {
    const source: SourceConfig = { id: 'webdav-more-preview', name: 'WebDAV', type: 'webdav', enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example/photos/', username: 'user', password: 'secret', includeSubdirectories: false };
    const firstPage = Array.from({ length: 6 }, (_, index) => ({ id: `first-${index}`, sourceId: source.id, remoteCacheEntryId: `first-${index}`, remoteCacheFingerprint: 'fingerprint' }));
    const secondPage = [{ id: 'seventh', sourceId: source.id, remoteCacheEntryId: 'seventh', remoteCacheFingerprint: 'fingerprint' }];
    const list = vi.fn(async (_source: SourceConfig, options?: { offset?: number; limit?: number }) => options?.offset === 6
      ? { ok: true as const, images: secondPage as [typeof secondPage[number]], offset: 6, nextOffset: 7, hasMore: false, totalCount: 7 }
      : { ok: true as const, images: firstPage as [typeof firstPage[number], ...typeof firstPage], offset: 0, nextOffset: 6, hasMore: true, totalCount: 7 });
    const materializePreview = vi.fn(async (entries: readonly ImageEntry[]) => ({
      entries: entries.map((entry) => ({ id: entry.id, sourceId: entry.sourceId, url: `blob:${entry.id}` })),
      release: vi.fn(),
      released: false
    } as unknown as RemoteCacheLease));
    render(<SourceEditor source={source} type="webdav" initialMode="manage" operations={{ ...operations, list, materializePreview }} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();

    expect(await screen.findAllByRole('img', { name: '图片预览缩略图' })).toHaveLength(6);
    expect(screen.getByLabelText('连接预览').querySelector('.source-preview__grid')).toContainElement(screen.getAllByRole('img', { name: '图片预览缩略图' })[0]!);
    await user.click(screen.getByRole('button', { name: '编辑完整配置' }));
    await user.click(screen.getByRole('button', { name: '加载更多预览' }));

    await waitFor(() => expect(screen.getAllByRole('img', { name: '图片预览缩略图' })).toHaveLength(7));
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ id: source.id, url: source.url, folderPath: [] }), { offset: 6, limit: 6 });
    expect(screen.queryByRole('button', { name: '加载更多预览' })).not.toBeInTheDocument();
  });

  it('keeps WebDAV browsing temporary until the folder is confirmed', async () => {
    const source: SourceConfig = { id: 'webdav-temporary-folder', name: 'WebDAV', type: 'webdav', enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example/photos/', folderPath: ['Family'], username: 'user', password: 'secret', includeSubdirectories: false };
    const test = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, protected: true as const, imageOrigins: ['https://dav.example/*'], count: 0, preview: [], directories: [{ id: `dir_${'a'.repeat(64)}`, name: 'Trips', relativeSegments: ['Trips'] }] })
      .mockResolvedValueOnce({ ok: true as const, protected: true as const, imageOrigins: ['https://dav.example/*'], count: 0, preview: [], directories: [] })
      .mockResolvedValueOnce({ ok: true as const, protected: true as const, imageOrigins: ['https://dav.example/*'], count: 0, preview: [], directories: [{ id: `dir_${'a'.repeat(64)}`, name: 'Trips', relativeSegments: ['Trips'] }] });
    const cached = [{ id: 'one', sourceId: source.id, remoteCacheEntryId: 'one', remoteCacheFingerprint: 'fingerprint' }] as [{ id: string; sourceId: string; remoteCacheEntryId: string; remoteCacheFingerprint: string }];
    const list = vi.fn(async () => ({ ok: true as const, images: cached }));
    const materializePreview = vi.fn(async () => ({ entries: [{ id: 'one', sourceId: source.id, url: 'blob:webdav-existing-preview' }], release: vi.fn(), released: false } as unknown as RemoteCacheLease));
    const onSave = vi.fn(async () => undefined);
    render(<SourceEditor source={source} type="webdav" initialMode="manage" operations={{ ...operations, test, list, materializePreview }} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();

    expect(await screen.findByRole('img', { name: '图片预览缩略图' })).toHaveAttribute('src', 'blob:webdav-existing-preview');
    expect(screen.getByRole('status')).toHaveTextContent('已加载 1 张预览');

    await user.click(screen.getByRole('button', { name: '修改目标文件夹' }));
    expect(await screen.findByText('当前路径：/Family')).toBeInTheDocument();
    const pickerDialog = screen.getByRole('dialog', { name: '选择 WebDAV 文件夹' });
    expect(pickerDialog.parentElement?.parentElement).toBe(document.body);
    expect(screen.getByRole('img', { name: '图片预览缩略图' })).toHaveAttribute('src', 'blob:webdav-existing-preview');
    expect(screen.getByText('已加载 1 张预览。')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '打开文件夹 Trips' }));
    expect(await screen.findByText('当前路径：/Family/Trips')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '图片预览缩略图' })).toHaveAttribute('src', 'blob:webdav-existing-preview');
    expect(screen.getByText('已加载 1 张预览。')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '取消选择' }));
    expect(screen.queryByRole('dialog', { name: '选择 WebDAV 文件夹' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: '图片预览缩略图' })).toHaveAttribute('src', 'blob:webdav-existing-preview');
    expect(screen.getByText('已加载 1 张预览。')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '修改目标文件夹' }));
    expect(await screen.findByText('当前路径：/Family')).toBeInTheDocument();
  });

  it('opens a saved WebDAV folder path from its root so the picker can return to the root', async () => {
    const source: SourceConfig = { id: 'webdav-saved-path', name: 'WebDAV', type: 'webdav', enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example/photos/', folderPath: ['家庭 相册'], username: 'user', password: 'secret', includeSubdirectories: false };
    const test = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, protected: true as const, imageOrigins: ['https://dav.example/*'], count: 0, preview: [], directories: [{ id: `dir_${'b'.repeat(64)}`, name: '2026', relativeSegments: ['2026'] }] })
      .mockResolvedValueOnce({ ok: true as const, protected: true as const, imageOrigins: ['https://dav.example/*'], count: 0, preview: [], directories: [{ id: `dir_${'a'.repeat(64)}`, name: '家庭 相册', relativeSegments: ['家庭 相册'] }] });
    const list = vi.fn(async () => ({ ok: false as const, images: [] as [], error: { code: 'empty' as const, message: 'empty' } }));
    const onSave = vi.fn(async () => undefined);
    render(<SourceEditor source={source} type="webdav" operations={{ ...operations, test, list }} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByText('当前路径：/家庭 相册')).toBeInTheDocument();
    expect(test).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'https://dav.example/photos/', folderPath: ['家庭 相册'] }));

    await user.click(screen.getByRole('button', { name: '根目录' }));
    await waitFor(() => expect(test).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'https://dav.example/photos/', folderPath: [] })));
    expect(screen.getByText('当前路径：/')).toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认选择' }));
    await waitFor(() => expect(onSave).not.toHaveBeenCalled());
    expect(screen.getByLabelText('WebDAV 地址')).toHaveValue('https://dav.example/photos/');
    await user.click(screen.getByRole('button', { name: '保存并使用' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://dav.example/photos/', folderPath: [] }));
  });

  it('clears stale WebDAV folders and connection status after credentials or URL change', async () => {
    const source: SourceConfig = { id: 'webdav-stale', name: 'WebDAV', type: 'webdav', enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example/photos', username: 'user', password: 'secret', includeSubdirectories: false };
    const test = vi.fn(async () => ({ ok: true as const, protected: true as const, imageOrigins: ['https://dav.example/*'], count: 0, preview: [], directories: [{ id: `dir_${'a'.repeat(64)}`, name: 'Family', relativeSegments: ['Family'] }] }));
    render(<SourceEditor source={source} type="webdav" operations={{ ...operations, test }} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByLabelText('WebDAV 文件夹层级')).toBeInTheDocument();
    await user.type(screen.getByLabelText('用户名'), '2');

    expect(screen.queryByLabelText('WebDAV 文件夹层级')).not.toBeInTheDocument();
    expect(screen.queryByText('连接成功。')).not.toBeInTheDocument();
  });

  it.each([
    ['URL', async (user: ReturnType<typeof userEvent.setup>) => { await user.clear(screen.getByLabelText('WebDAV 地址')); await user.type(screen.getByLabelText('WebDAV 地址'), 'https://dav.example/new/'); }],
    ['用户名', async (user: ReturnType<typeof userEvent.setup>) => { await user.clear(screen.getByLabelText('用户名')); await user.type(screen.getByLabelText('用户名'), 'new-user'); }],
    ['密码', async (user: ReturnType<typeof userEvent.setup>) => { await user.clear(screen.getByLabelText('密码')); await user.type(screen.getByLabelText('密码'), 'new-secret'); }]
  ])('does not start a stale WebDAV test after permission is granted when %s changed', async (_field, editIdentity) => {
    const source: SourceConfig = { id: 'webdav-permission-stale', name: 'WebDAV', type: 'webdav', enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example/photos/', username: 'user', password: 'secret', includeSubdirectories: false };
    const test = vi.fn(async () => ({ ok: true as const, protected: true as const, imageOrigins: ['https://dav.example/*'], count: 0, preview: [], directories: [] }));
    let first = true;
    let grant!: () => void;
    const withOriginPermissions: SourceOperations['withOriginPermissions'] = async <T,>(_urls: string[], operation: () => Promise<T>) => {
      if (!first) return { ok: true, value: await operation() };
      first = false;
      return new Promise<OriginPermissionOperationResult<T>>((resolve) => { grant = () => { void operation().then((value) => resolve({ ok: true, value })); }; });
    };
    render(<SourceEditor source={source} type="webdav" operations={{ ...operations, test, withOriginPermissions }} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await editIdentity(user);
    grant();
    await waitFor(() => expect(screen.getByRole('button', { name: '测试连接' })).toBeEnabled());
    expect(test).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('连接成功'));
    expect(test).toHaveBeenCalledOnce();
  });

  it('explains the browser permission step while a remote source test is waiting for host access', async () => {
    const source: SourceConfig = { id: 'webdav-permission-wait', name: 'WebDAV', type: 'webdav', enabled: true, createdAt: 1, updatedAt: 1, url: 'https://dav.example/photos/', username: 'user', password: 'secret', includeSubdirectories: false };
    const test = vi.fn(async () => ({ ok: true as const, protected: true as const, imageOrigins: ['https://dav.example/*'], count: 0, preview: [], directories: [] }));
    const withOriginPermissions: SourceOperations['withOriginPermissions'] = async <T,>() => new Promise<OriginPermissionOperationResult<T>>(() => {});
    render(<SourceEditor source={source} type="webdav" operations={{ ...operations, test, withOriginPermissions }} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);

    await userEvent.setup().click(screen.getByRole('button', { name: '测试连接' }));

    expect(screen.getByRole('status')).toHaveTextContent('请在浏览器弹出的权限窗口中允许访问目标域名');
    expect(screen.getByRole('button', { name: '正在测试…' })).toBeDisabled();
    expect(test).not.toHaveBeenCalled();
  });

  it('finishes a successful TMDB connection test before metadata settles and does not request a preview', async () => {
    const source: TmdbSourceConfig = { id: 'tmdb-connection', name: 'TMDB', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1, token: 'token', media: 'movie', feed: 'popular', discoverFilters: {} };
    const loadTmdbMetadata = vi.fn(() => new Promise<TmdbMetadataResult>(() => {}));
    const list = vi.fn(async () => ({ ok: false as const, images: [] as [], error: { code: 'network' as const, message: 'must not list' } }));
    const materializePreview = vi.fn();
    render(<SourceEditor source={source} type="tmdb" operations={{ ...operations, loadTmdbMetadata, list, materializePreview }} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);

    await userEvent.setup().click(screen.getByRole('button', { name: '测试连接' }));
    await Promise.resolve();

    expect(screen.getByRole('status')).toHaveTextContent('连接成功');
    expect(screen.getByRole('button', { name: '测试连接' })).toBeEnabled();
    expect(screen.getByLabelText('官方分类')).toBeDisabled();
    expect(loadTmdbMetadata).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
    expect(materializePreview).not.toHaveBeenCalled();
  });

  it('keeps TMDB connected when category metadata fails and allows the user to retry it', async () => {
    const source: TmdbSourceConfig = { id: 'tmdb-metadata-retry', name: 'TMDB', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1, token: 'token', media: 'movie', feed: 'popular', discoverFilters: {} };
    const loadTmdbMetadata = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: { message: 'metadata unavailable' } })
      .mockResolvedValueOnce({ ok: true as const, genres: [{ id: 28, name: 'Action' }], languages: ['en-US', 'zh-CN'], regions: ['CN', 'US'] });
    const custom: SourceOperations = { ...operations, loadTmdbMetadata };
    render(<SourceEditor source={source} type="tmdb" operations={custom} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('连接成功，但配置选项加载失败'));
    expect(screen.getByRole('button', { name: '测试连接' })).toBeEnabled();
    expect(screen.getByLabelText('内容分类')).toBeEnabled();
    expect(screen.getByLabelText('官方分类')).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(screen.getByLabelText('官方分类')).toBeEnabled());
    expect(loadTmdbMetadata).toHaveBeenCalledTimes(2);
  });

  it('lets TMDB static feed and discover filters be configured before testing the connection', async () => {
    const source: TmdbSourceConfig = { id: 'tmdb-config-first', name: 'TMDB', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1, token: 'token', media: 'movie', feed: 'popular', discoverFilters: {} };
    const onSave = vi.fn(async () => undefined);
    render(<SourceEditor source={source} type="tmdb" operations={operations} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();

    expect(screen.getByLabelText('内容分类')).toBeEnabled();
    await user.selectOptions(screen.getByLabelText('内容分类'), 'discover');
    expect(screen.getByLabelText('上映年份')).toBeEnabled();
    await user.type(screen.getByLabelText('上映年份'), '2026');
    await user.click(screen.getByRole('button', { name: '保存并使用' }));

    expect(screen.getByRole('alert')).toHaveTextContent('请先测试 TMDB 连接');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('preserves direct stable IDs and optional labels when saved unchanged', async () => {
    const source: SourceConfig = { id: 'direct', name: 'Direct', type: 'direct', enabled: false, createdAt: 10, updatedAt: 20, entries: [{ id: 'stable-a', url: 'https://one.example/a.jpg', label: 'A label' }, { id: 'stable-b', url: 'https://two.example/b.jpg' }] };
    await expect(saveUnchanged(source)).resolves.toEqual({ ...source, updatedAt: expect.any(Number) });
  });

  it('keeps Direct row IDs through reordering but generates a new cache identity when its URL changes', async () => {
    const source: SourceConfig = { id: 'direct-rows', name: 'Rows', type: 'direct', enabled: true, createdAt: 1, updatedAt: 1, entries: [{ id: 'stable-a', url: 'https://one.example/a.jpg' }, { id: 'stable-b', url: 'https://two.example/b.jpg' }] };
    const user = userEvent.setup(); const reordered = vi.fn(async () => undefined);
    const first = render(<SourceEditor source={source} type="direct" operations={operations} onSave={reordered} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '下移图片 1' })); await user.click(screen.getByRole('button', { name: '保存并使用' }));
    expect(reordered).toHaveBeenCalledWith(expect.objectContaining({ entries: [expect.objectContaining({ id: 'stable-b' }), expect.objectContaining({ id: 'stable-a' })] }));
    first.unmount();

    const replaced = vi.fn(async (_value: SourceConfig) => undefined);
    render(<SourceEditor source={source} type="direct" operations={operations} onSave={replaced} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    await user.clear(screen.getByLabelText('图片 URL 1')); await user.type(screen.getByLabelText('图片 URL 1'), 'https://one.example/replaced.jpg'); await user.click(screen.getByRole('button', { name: '保存并使用' }));
    const saved = replaced.mock.calls[0]?.[0] as Extract<SourceConfig, { type: 'direct' }>;
    expect(saved.entries[0]?.id).not.toBe('stable-a'); expect(saved.entries[1]?.id).toBe('stable-b');

    cleanup();
    const inserted = vi.fn(async (_value: SourceConfig) => undefined);
    render(<SourceEditor source={source} type="direct" operations={operations} onSave={inserted} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '添加图片' }));
    await user.type(screen.getByLabelText('图片 URL 3'), 'https://three.example/c.jpg');
    await user.click(screen.getByRole('button', { name: '保存并使用' }));
    const insertedSource = inserted.mock.calls[0]?.[0] as Extract<SourceConfig, { type: 'direct' }>;
    expect(new Set(insertedSource.entries.map((entry) => entry.id)).size).toBe(3);
    expect(insertedSource.entries.slice(0, 2).map((entry) => entry.id)).toEqual(['stable-a', 'stable-b']);
  });

  it('preserves the complete JSON mapping and pagination configuration', async () => {
    const source: JsonApiSourceConfig = { id: 'json', name: 'JSON', type: 'json-api', enabled: false, createdAt: 10, updatedAt: 20, endpoint: 'https://api.example/images', headers: { Authorization: 'Bearer private', 'X-Mode': 'safe' }, authorizedImageOrigins: ['https://images.example/*'], arrayPath: 'data.items', fields: { imageUrl: 'urls.large', stableId: 'uuid', title: 'title', author: 'owner.name', sourcePage: 'links.page', width: 'size.w', height: 'size.h' }, startingPage: 3, pageParam: 'cursor' };
    await expect(saveUnchanged(source)).resolves.toEqual({ ...source, updatedAt: expect.any(Number) });
  });

  it('preserves all supported TMDB discover filters', async () => {
    const source: TmdbSourceConfig = { id: 'tmdb', name: 'Cinema', type: 'tmdb', enabled: false, createdAt: 10, updatedAt: 20, token: 'private', media: 'movie', feed: 'discover', discoverFilters: { with_genres: '28', language: 'zh-CN', region: 'CN', primary_release_year: 2025, 'primary_release_date.gte': '2025-01-02', 'primary_release_date.lte': '2025-11-30', 'vote_average.gte': 7.5, sort_by: 'popularity.desc', page: 2 } };
    await expect(saveUnchanged(source)).resolves.toEqual({ ...source, updatedAt: expect.any(Number) });
  });

  it('renders TMDB language and region as choices and saves the selected codes', async () => {
    const user = userEvent.setup();
    const source: TmdbSourceConfig = { id: 'tmdb-options', name: 'TMDB', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1, token: 'token', media: 'movie', feed: 'popular', discoverFilters: {} };
    const onSave = vi.fn(async () => undefined);
    render(<SourceEditor source={source} type="tmdb" operations={operations} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);

    expect(screen.getByLabelText('语言')).toHaveProperty('tagName', 'SELECT');
    expect(screen.getByLabelText('地区')).toHaveProperty('tagName', 'SELECT');
    expect(screen.getByLabelText('语言')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(screen.getByLabelText('语言')).toBeEnabled());
    await user.selectOptions(screen.getByLabelText('语言'), 'zh-CN');
    await user.selectOptions(screen.getByLabelText('地区'), 'CN');
    await user.click(screen.getByRole('button', { name: '保存并使用' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ discoverFilters: expect.objectContaining({ language: 'zh-CN', region: 'CN' }) }));
  });

  it('preserves saved TMDB locale codes that are absent from the latest option lists', async () => {
    const source: TmdbSourceConfig = { id: 'tmdb-legacy-options', name: 'TMDB', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1, token: 'token', media: 'movie', feed: 'popular', discoverFilters: { language: 'es-MX', region: 'MX' } };
    const onSave = vi.fn(async () => undefined);
    render(<SourceEditor source={source} type="tmdb" operations={operations} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);

    await userEvent.setup().click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(screen.getByLabelText('语言')).toBeEnabled());
    expect(screen.getByLabelText('语言')).toHaveValue('es-MX');
    expect(screen.getByLabelText('地区')).toHaveValue('MX');
    await userEvent.setup().click(screen.getByRole('button', { name: '保存并使用' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ discoverFilters: expect.objectContaining({ language: 'es-MX', region: 'MX' }) }));
  });

  it('switches TMDB to Discover when an official genre is selected so the category affects API results', async () => {
    const user = userEvent.setup();
    const source: TmdbSourceConfig = { id: 'tmdb-genre', name: 'TMDB', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1, token: 'token', media: 'movie', feed: 'popular', discoverFilters: {} };
    const onSave = vi.fn(async () => undefined);
    render(<SourceEditor source={source} type="tmdb" operations={{ ...operations, loadTmdbMetadata: vi.fn(async () => ({ ok: true as const, genres: [{ id: 28, name: 'Action' }], languages: ['en-US', 'zh-CN'], regions: ['CN', 'US'] })) }} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await screen.findByRole('option', { name: 'Action' });
    await user.selectOptions(screen.getByLabelText('官方分类'), '28');
    expect(screen.getByLabelText('内容分类')).toHaveValue('discover');

    await user.click(screen.getByRole('button', { name: '保存并使用' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      feed: 'discover',
      discoverFilters: expect.objectContaining({ with_genres: '28' })
    }));
  });

  it('hides sensitive JSON headers by default and preserves them unchanged', async () => {
    const source: JsonApiSourceConfig = { id: 'json-secret', name: 'Secret API', type: 'json-api', enabled: true, createdAt: 1, updatedAt: 1, endpoint: 'https://api.example/list', headers: { Authorization: 'Bearer private', 'X-Mode': 'safe' }, authorizedImageOrigins: [], arrayPath: 'items', fields: { imageUrl: 'url' }, startingPage: 1 };
    const user = userEvent.setup();
    render(<SourceEditor source={source} type="json-api" operations={operations} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const secret = screen.getByLabelText('Authorization 值');
    expect(secret).toHaveAttribute('type', 'password');
    expect(document.body).not.toHaveTextContent('Bearer private');
    expect(screen.getByLabelText('X-Mode 值')).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: '显示 Authorization' }));
    expect(secret).toHaveAttribute('type', 'text');
  });

  it('uses two explicit user gestures: endpoint permission before discovery, then one batch image-origin permission before cache preview', async () => {
    const source: JsonApiSourceConfig = { id: 'json-preview', name: 'Preview API', type: 'json-api', enabled: true, createdAt: 1, updatedAt: 1, endpoint: 'https://api.example/list', headers: {}, authorizedImageOrigins: [], arrayPath: 'items', fields: { imageUrl: 'url' }, startingPage: 1 };
    const order: string[] = [];
    const release = vi.fn();
    const custom: SourceOperations = {
      ...operations,
      test: vi.fn(async () => { order.push('network'); return { ok: true as const, protected: true as const, imageOrigins: ['https://cdn.one/*', 'https://cdn.two/*'], count: 2, preview: [{ id: 'opaque-a', sourceId: source.id }] }; }),
      withOriginPermissions: vi.fn(async (urls, operation) => { order.push(`permission:${urls.join(',')}`); return { ok: true as const, value: await operation() }; }),
      list: vi.fn(async () => ({ ok: true as const, images: [{ id: 'a', sourceId: source.id, remoteCacheEntryId: 'a', remoteCacheFingerprint: 'fingerprint' }] as [{ id: string; sourceId: string; remoteCacheEntryId: string; remoteCacheFingerprint: string }] })),
      materializePreview: vi.fn(async () => ({ entries: [{ id: 'a', sourceId: source.id, url: 'blob:private-preview' }], release, released: false } as unknown as RemoteCacheLease))
    };
    const onSave = vi.fn(async () => undefined);
    const view = render(<SourceEditor source={source} type="json-api" operations={custom} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '测试 API' }));

    await waitFor(() => expect(screen.getByRole('button', { name: '授权图片域并完成预览' })).toBeEnabled());
    expect(view.container.innerHTML).not.toContain('private-album');
    expect(view.container.innerHTML).not.toContain('signed-secret');
    expect(order).toEqual(['permission:https://api.example/list', 'network']);
    expect(custom.list).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '授权图片域并完成预览' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '图片预览缩略图' })).toHaveAttribute('src', 'blob:private-preview'));
    expect(order).toEqual(['permission:https://api.example/list', 'network', 'permission:https://api.example/list,https://cdn.one/*,https://cdn.two/*']);
    expect(custom.list).toHaveBeenCalledWith(expect.objectContaining({ authorizedImageOrigins: ['https://cdn.one/*', 'https://cdn.two/*'] }), { offset: 0, limit: 6 });
    await user.click(screen.getByRole('button', { name: '保存并使用' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ authorizedImageOrigins: ['https://cdn.one/*', 'https://cdn.two/*'] }));
    view.unmount();
    expect(release).toHaveBeenCalledOnce();
  });

  it('stops at either denied permission phase and never performs the later network operation', async () => {
    const source: JsonApiSourceConfig = { id: 'json-denied', name: 'Denied API', type: 'json-api', enabled: true, createdAt: 1, updatedAt: 1, endpoint: 'https://api.example/list', headers: {}, authorizedImageOrigins: [], arrayPath: 'items', fields: { imageUrl: 'url' }, startingPage: 1 };
    const test = vi.fn(async () => ({ ok: true as const, protected: true as const, imageOrigins: ['https://cdn.example/*'], count: 1, preview: [] }));
    const list = vi.fn();
    const firstDenied = { ...operations, test, list, withOriginPermissions: vi.fn(async () => ({ ok: false as const, error: { code: 'permission-denied' as const, message: '拒绝' } })) };
    const first = render(<SourceEditor source={source} type="json-api" operations={firstDenied} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: '测试 API' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('拒绝'));
    expect(test).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
    first.unmount();

    let permissionCall = 0;
    const secondDenied: SourceOperations = { ...operations, test, list, withOriginPermissions: vi.fn(async (_urls, operation) => ++permissionCall === 1 ? { ok: true as const, value: await operation() } : { ok: false as const, error: { code: 'permission-denied' as const, message: '图片域拒绝' } }) };
    render(<SourceEditor source={source} type="json-api" operations={secondDenied} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: '测试 API' }));
    await user.click(await screen.findByRole('button', { name: '授权图片域并完成预览' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('图片域拒绝'));
    expect(list).not.toHaveBeenCalled();
  });

  it('offers an explicit completion step when the API discovery contains no image CDN origin', async () => {
    const source: JsonApiSourceConfig = { id: 'json-empty-origins', name: 'Same-origin API', type: 'json-api', enabled: true, createdAt: 1, updatedAt: 1, endpoint: 'https://api.example/list', headers: {}, authorizedImageOrigins: [], arrayPath: 'items', fields: { imageUrl: 'url' }, startingPage: 1 };
    const permissions: string[][] = [];
    const custom: SourceOperations = { ...operations, test: vi.fn(async () => ({ ok: true as const, protected: true as const, imageOrigins: [], count: 0, preview: [] })), withOriginPermissions: vi.fn(async (urls, operation) => { permissions.push([...urls]); return { ok: true as const, value: await operation() }; }), list: vi.fn(async () => ({ ok: true as const, images: [{ id: 'cached', sourceId: source.id, remoteCacheEntryId: 'cached', remoteCacheFingerprint: 'fingerprint' }] as [{ id: string; sourceId: string; remoteCacheEntryId: string; remoteCacheFingerprint: string }] })), materializePreview: vi.fn(async () => ({ entries: [], release: vi.fn(), released: false } as unknown as RemoteCacheLease)) };
    render(<SourceEditor source={source} type="json-api" operations={custom} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: '测试 API' }));
    await waitFor(() => expect(screen.getAllByText(/未发现独立图片域/)).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: '授权图片域并完成预览' }));
    await waitFor(() => expect(permissions).toEqual([[source.endpoint], [source.endpoint]]));
  });

  it('materializes at most six images and releases a late lease after unmount without publishing it', async () => {
    const source: JsonApiSourceConfig = { id: 'json-late', name: 'Late API', type: 'json-api', enabled: true, createdAt: 1, updatedAt: 1, endpoint: 'https://api.example/list', headers: {}, authorizedImageOrigins: [], arrayPath: 'items', fields: { imageUrl: 'url' }, startingPage: 1 };
    const listed = Array.from({ length: 500 }, (_, index) => ({ id: String(index), sourceId: source.id, remoteCacheEntryId: String(index), remoteCacheFingerprint: 'fingerprint' })) as [{ id: string; sourceId: string; remoteCacheEntryId: string; remoteCacheFingerprint: string }, ...{ id: string; sourceId: string; remoteCacheEntryId: string; remoteCacheFingerprint: string }[]];
    let resolveLease!: (lease: RemoteCacheLease) => void;
    const release = vi.fn();
    const materializePreview = vi.fn(() => new Promise<RemoteCacheLease>((resolve) => { resolveLease = resolve; }));
    const custom: SourceOperations = { ...operations, test: vi.fn(async () => ({ ok: true as const, protected: true as const, imageOrigins: ['https://cdn.example/*'], count: 1, preview: [] })), list: vi.fn(async () => ({ ok: true as const, images: listed })), materializePreview };
    const view = render(<SourceEditor source={source} type="json-api" operations={custom} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: '测试 API' })); await user.click(await screen.findByRole('button', { name: '授权图片域并完成预览' }));
    await waitFor(() => expect(materializePreview).toHaveBeenCalledWith(listed.slice(0, 6)));
    view.unmount();
    resolveLease({ entries: [{ id: 'late', sourceId: source.id, url: 'blob:late' }], release, released: false } as unknown as RemoteCacheLease);
    await waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(document.querySelector('img[src="blob:late"]')).toBeNull();
  });

  it('invalidates discovered origins after a configuration edit and prevents saving them before a new completion', async () => {
    const source: JsonApiSourceConfig = { id: 'json-edit', name: 'Edit API', type: 'json-api', enabled: true, createdAt: 1, updatedAt: 1, endpoint: 'https://api.example/list', headers: {}, authorizedImageOrigins: ['https://old.example/*'], arrayPath: 'items', fields: { imageUrl: 'url' }, startingPage: 1 };
    const onSave = vi.fn();
    const custom = { ...operations, test: vi.fn(async () => ({ ok: true as const, protected: true as const, imageOrigins: ['https://new.example/*'], count: 1, preview: [] })) };
    render(<SourceEditor source={source} type="json-api" operations={custom} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: '测试 API' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '授权图片域并完成预览' })).toBeEnabled());
    await user.clear(screen.getByLabelText('图片 URL 字段')); await user.type(screen.getByLabelText('图片 URL 字段'), 'image.large');
    expect(screen.getByRole('button', { name: '授权图片域并完成预览' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '保存并使用' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请先完成 API 测试');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('completes a connection test under React StrictMode without remaining busy', async () => {
    const source: SourceConfig = { id: 'strict', name: 'Strict', type: 'direct', enabled: true, createdAt: 1, updatedAt: 1, entries: [{ id: 'a', url: 'https://images.example/a.jpg' }] };
    render(<StrictMode><SourceEditor source={source} type="direct" operations={operations} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} /></StrictMode>);
    await userEvent.setup().click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('连接成功'));
    expect(screen.getByRole('button', { name: '测试连接' })).toBeEnabled();
  });

  it.each([
    ['token', async (user: ReturnType<typeof userEvent.setup>) => { await user.clear(screen.getByLabelText('API Read Token')); await user.type(screen.getByLabelText('API Read Token'), 'new-token'); }],
    ['media', async (user: ReturnType<typeof userEvent.setup>) => { await user.selectOptions(screen.getByLabelText('媒体类型'), 'tv'); }]
  ])('invalidates a deferred TMDB test when its %s changes so the old success cannot unlock filters', async (_identity, editIdentity) => {
    const source: TmdbSourceConfig = { id: 'tmdb-late', name: 'TMDB', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1, token: 'old-token', media: 'movie', feed: 'popular', discoverFilters: {} };
    let resolveTest!: (result: { ok: true }) => void;
    const test = vi.fn(() => new Promise<{ ok: true }>((resolve) => { resolveTest = resolve; }));
    const loadTmdbMetadata = vi.fn(async () => ({ ok: true as const, genres: [], languages: ['en-US', 'zh-CN'], regions: ['CN', 'US'] }));
    render(<SourceEditor source={source} type="tmdb" operations={{ ...operations, test, loadTmdbMetadata }} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: '测试连接' }));
    await editIdentity(user);
    resolveTest({ ok: true });
    await Promise.resolve(); await Promise.resolve();
    expect(screen.getByLabelText('官方分类')).toBeDisabled(); expect(loadTmdbMetadata).not.toHaveBeenCalled();
  });

  it('does not request dynamic browser host permission for the built-in TMDB provider', async () => {
    const source: TmdbSourceConfig = { id: 'tmdb-static-permission', name: 'TMDB', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1, token: 'token', media: 'movie', feed: 'popular', discoverFilters: {} };
    const test = vi.fn(async () => ({ ok: true as const }));
    const loadTmdbMetadata = vi.fn(async () => ({ ok: true as const, genres: [], languages: ['en-US', 'zh-CN'], regions: ['CN', 'US'] }));
    const withOriginPermissions: SourceOperations['withOriginPermissions'] = vi.fn(async (_urls, operation) => ({ ok: true as const, value: await operation() }));
    render(<SourceEditor source={source} type="tmdb" operations={{ ...operations, test, loadTmdbMetadata, withOriginPermissions }} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(screen.getByLabelText('内容分类')).toBeEnabled());
    expect(screen.queryByText('请在浏览器弹出的权限窗口中允许访问目标域名')).not.toBeInTheDocument();
    expect(withOriginPermissions).not.toHaveBeenCalled();
    expect(test).toHaveBeenCalledOnce();
    expect(loadTmdbMetadata).toHaveBeenCalledOnce();
  });

  it('has no dynamic permission targets for TMDB because its fixed domains are declared in the manifest', () => {
    const source: TmdbSourceConfig = { id: 'tmdb-targets', name: 'TMDB', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1, token: 'token', media: 'movie', feed: 'popular', discoverFilters: {} };

    expect(permissionTargetsForSource(source)).toEqual([]);
  });

  it('keeps a deferred TMDB connection test valid when only a filter changes', async () => {
    const source: TmdbSourceConfig = { id: 'tmdb-filter-late', name: 'TMDB', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1, token: 'token', media: 'movie', feed: 'discover', discoverFilters: {} };
    let resolveTest!: (result: { ok: true }) => void;
    const test = vi.fn(() => new Promise<{ ok: true }>((resolve) => { resolveTest = resolve; }));
    const loadTmdbMetadata = vi.fn(async () => ({ ok: true as const, genres: [{ id: 28, name: 'Action' }], languages: ['en-US', 'zh-CN'], regions: ['CN', 'US'] }));
    render(<SourceEditor source={source} type="tmdb" operations={{ ...operations, test, loadTmdbMetadata }} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await user.type(screen.getByLabelText('结果页'), '2');
    resolveTest({ ok: true });

    await waitFor(() => expect(screen.getByLabelText('官方分类')).toBeEnabled());
    expect(loadTmdbMetadata).toHaveBeenCalledOnce();
  });

  it.each([
    ['token', async (user: ReturnType<typeof userEvent.setup>) => { await user.clear(screen.getByLabelText('API Read Token')); await user.type(screen.getByLabelText('API Read Token'), 'changed-token'); }],
    ['media', async (user: ReturnType<typeof userEvent.setup>) => { await user.selectOptions(screen.getByLabelText('媒体类型'), 'tv'); }]
  ])('requires a fresh TMDB test after %s changes', async (_identity, editIdentity) => {
    const source: TmdbSourceConfig = { id: 'tmdb-identity', name: 'TMDB', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1, token: 'token', media: 'movie', feed: 'discover', discoverFilters: {} };
    const onSave = vi.fn(async () => undefined);
    render(<SourceEditor source={source} type="tmdb" operations={operations} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(screen.getByLabelText('官方分类')).toBeEnabled());
    await editIdentity(user);
    await user.click(screen.getByRole('button', { name: '保存并使用' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请先测试 TMDB 连接');
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each([
    ['feed', async (user: ReturnType<typeof userEvent.setup>) => user.selectOptions(screen.getByLabelText('内容分类'), 'popular')],
    ['genre', async (user: ReturnType<typeof userEvent.setup>) => user.selectOptions(screen.getByLabelText('官方分类'), '28')],
    ['language', async (user: ReturnType<typeof userEvent.setup>) => user.selectOptions(screen.getByLabelText('语言'), 'zh-CN')],
    ['region', async (user: ReturnType<typeof userEvent.setup>) => user.selectOptions(screen.getByLabelText('地区'), 'CN')],
    ['year', async (user: ReturnType<typeof userEvent.setup>) => user.type(screen.getByLabelText('上映年份'), '2026')],
    ['date from', async (user: ReturnType<typeof userEvent.setup>) => user.type(screen.getByLabelText('上映日期从'), '2026-01-01')],
    ['date to', async (user: ReturnType<typeof userEvent.setup>) => user.type(screen.getByLabelText('上映日期至'), '2026-12-31')],
    ['rating', async (user: ReturnType<typeof userEvent.setup>) => user.type(screen.getByLabelText('最低评分'), '7.5')],
    ['sort', async (user: ReturnType<typeof userEvent.setup>) => user.type(screen.getByLabelText('排序'), 'popularity.desc')],
    ['page', async (user: ReturnType<typeof userEvent.setup>) => { await user.clear(screen.getByLabelText('结果页')); await user.type(screen.getByLabelText('结果页'), '2'); }]
  ])('keeps the tested TMDB connection saveable when only %s changes', async (_field, editFilter) => {
    const source: TmdbSourceConfig = { id: 'tmdb-filter', name: 'TMDB', type: 'tmdb', enabled: true, createdAt: 1, updatedAt: 1, token: 'token', media: 'movie', feed: 'discover', discoverFilters: {} };
    const onSave = vi.fn(async () => undefined);
    render(<SourceEditor source={source} type="tmdb" operations={operations} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(screen.getByLabelText('官方分类')).toBeEnabled());
    await editFilter(user);
    expect(screen.getByLabelText('官方分类')).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '保存并使用' }));
    expect(onSave).toHaveBeenCalledOnce();
  });
});

describe('SourceEditor local gallery', () => {
  const local: SourceConfig = { id: 'local', name: 'Local', type: 'local', enabled: true, createdAt: 1, updatedAt: 1, includeSubdirectories: false };

  beforeEach(removeImageDatabase);
  afterEach(removeImageDatabase);

  it('rolls back real IndexedDB blobs when saving a new local source fails and retries without duplicates', async () => {
    const adapter = new LocalSourceAdapter();
    const realOperations = createSourceOperations(adapter);
    const onSave = vi.fn().mockRejectedValueOnce(new Error('private save failure')).mockResolvedValueOnce(undefined);
    render(<SourceEditor type="local" operations={realOperations} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('图片源名称'), 'Rollback local');
    await user.upload(screen.getByLabelText('导入本地图片'), new File(['one'], 'one.jpg', { type: 'image/jpeg' }));

    await user.click(screen.getByRole('button', { name: '保存并使用' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('已清理'));
    const firstSource = onSave.mock.calls[0]?.[0] as SourceConfig;
    expect(await listLocal(firstSource.id)).toEqual([]);

    await user.click(screen.getByRole('button', { name: '保存并使用' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    const secondSource = onSave.mock.calls[1]?.[0] as SourceConfig;
    expect(secondSource.id).not.toBe(firstSource.id);
    expect(await listLocal()).toHaveLength(1);
    expect(await listLocal(firstSource.id)).toEqual([]);
    await realOperations.completeLocalImport?.(secondSource.id);
  });

  it('rolls back partial real IndexedDB writes when a new local import rejects before save', async () => {
    const adapter = new LocalSourceAdapter();
    const realOperations = createSourceOperations(adapter);
    const importLocal = vi.fn(async (sourceId: string, files: File[]) => {
      await realOperations.importLocal(sourceId, files);
      throw new Error('private import failure');
    });
    const onSave = vi.fn(async () => undefined);
    render(<SourceEditor type="local" operations={{ ...realOperations, importLocal }} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('图片源名称'), 'Partial import');
    await user.upload(screen.getByLabelText('导入本地图片'), new File(['one'], 'one.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: '保存并使用' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('已清理'));
    expect(onSave).not.toHaveBeenCalled();
    expect(await listLocal()).toEqual([]);
  });

  it('does not reimport while failed rollback cleanup still needs retry', async () => {
    const adapter = new LocalSourceAdapter({}, {
      listLocal,
      putLocal,
      deleteSource: vi.fn(async () => { throw new Error('private cleanup failure'); })
    });
    const realOperations = createSourceOperations(adapter);
    const importLocal = vi.fn(realOperations.importLocal);
    const deleteSource = vi.fn(realOperations.delete);
    const onSave = vi.fn(async () => { throw new Error('private save failure'); });
    render(<SourceEditor type="local" operations={{ ...realOperations, importLocal, delete: deleteSource }} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('图片源名称'), 'Cleanup retry');
    await user.upload(screen.getByLabelText('导入本地图片'), new File(['one'], 'one.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: '保存并使用' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('本地清理失败'));
    expect(screen.getByRole('alert')).not.toHaveTextContent('private');
    expect(await listLocal()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '保存并使用' }));
    await waitFor(() => expect(deleteSource).toHaveBeenCalledTimes(2));
    expect(importLocal).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(await listLocal()).toHaveLength(1);
  });

  it('never deletes an existing local gallery when updating its config fails', async () => {
    const adapter = new LocalSourceAdapter();
    const realOperations = createSourceOperations(adapter);
    const file = new File(['original'], 'original.jpg', { type: 'image/jpeg' });
    await realOperations.importLocal(local.id, [file]);
    const deleteSource = vi.fn(realOperations.delete);
    render(<SourceEditor source={local} type="local" operations={{ ...realOperations, delete: deleteSource }} onSave={vi.fn(async () => { throw new Error('private save failure'); })} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: '保存并使用' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('保存'));
    expect(deleteSource).not.toHaveBeenCalled();
    expect(await listLocal(local.id)).toHaveLength(1);
  });

  it('recovers a persisted failed cleanup after unmount before a remounted editor can import again', async () => {
    const failingAdapter = new LocalSourceAdapter({}, {
      listLocal,
      putLocal,
      deleteSource: vi.fn(async () => { throw new Error('private cleanup failure'); })
    });
    const firstOperations = createSourceOperations(failingAdapter);
    const first = render(<SourceEditor type="local" operations={firstOperations} onSave={vi.fn(async () => { throw new Error('private save failure'); })} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('图片源名称'), 'Interrupted cleanup');
    await user.upload(screen.getByLabelText('导入本地图片'), new File(['orphan'], 'orphan.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: '保存并使用' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('本地清理失败'));
    expect(await listLocal()).toHaveLength(1);
    first.unmount();

    const recoveredAdapter = new LocalSourceAdapter();
    const recoveredOperations = createSourceOperations(recoveredAdapter);
    const second = render(<SourceEditor type="local" operations={recoveredOperations} onSave={vi.fn(async () => undefined)} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    await recoveredOperations.recoverLocalImports?.();
    await waitFor(async () => expect(await listLocal()).toEqual([]));
    expect(screen.getByRole('button', { name: '保存并使用' })).toBeEnabled();
    second.unmount();
  });

  it('recovers the crash window after import persisted but before onSave settled', async () => {
    let settleSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => { settleSave = resolve; });
    const adapter = new LocalSourceAdapter();
    const firstOperations = createSourceOperations(adapter);
    const onSave = vi.fn((_source: SourceConfig) => pendingSave);
    const first = render(<SourceEditor type="local" operations={firstOperations} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('图片源名称'), 'Crash window');
    await user.upload(screen.getByLabelText('导入本地图片'), new File(['orphan'], 'orphan.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: '保存并使用' }));
    await waitFor(async () => expect(await listLocal()).toHaveLength(1));
    first.unmount();
    firstOperations.abandonLocalImports?.();

    const recoveredOperations = createSourceOperations(new LocalSourceAdapter());
    await recoveredOperations.recoverLocalImports?.();
    await waitFor(async () => expect(await listLocal()).toEqual([]));
    settleSave();
    await Promise.resolve();
    await firstOperations.completeLocalImport?.((onSave.mock.calls[0]?.[0] as SourceConfig).id);
  });

  it('does not import an existing source selection a second time when saving', async () => {
    const user = userEvent.setup();
    const importLocal = vi.fn(async () => ({ imported: 1, failures: [] }));
    const onSave = vi.fn(async () => undefined);
    render(<SourceEditor source={local} type="local" operations={{ ...operations, importLocal, listLocalFiles: vi.fn(async () => []) }} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    const file = new File(['one'], 'one.jpg', { type: 'image/jpeg' });

    await user.upload(screen.getByLabelText('导入本地图片'), file);
    await user.click(screen.getByRole('button', { name: '保存并使用' }));

    expect(importLocal).toHaveBeenCalledTimes(1);
  });

  it('imports a new source drop before saving/activating it', async () => {
    const calls: string[] = [];
    const importLocal = vi.fn(async () => { calls.push('import'); return { imported: 1, failures: [] }; });
    const onSave = vi.fn(async () => { calls.push('save'); });
    render(<SourceEditor type="local" operations={{ ...operations, importLocal, listLocalFiles: vi.fn(async () => []) }} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    await userEvent.setup().type(screen.getByLabelText('图片源名称'), 'New local');
    const file = new File(['one'], 'one.jpg', { type: 'image/jpeg' });

    fireEvent.drop(screen.getByTestId('local-dropzone'), { dataTransfer: { files: [file] } });
    await userEvent.setup().click(screen.getByRole('button', { name: '保存并使用' }));

    await waitFor(() => expect(calls).toEqual(['import', 'save']));
  });

  it('does not activate a new empty local source', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<SourceEditor type="local" operations={{ ...operations, listLocalFiles: vi.fn(async () => []) }} onSave={onSave} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    await userEvent.setup().type(screen.getByLabelText('图片源名称'), 'Empty local');
    await userEvent.setup().click(screen.getByRole('button', { name: '保存并使用' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请先导入');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows private thumbnails and exposes delete and accessible reorder actions', async () => {
    const user = userEvent.setup();
    const deleteLocalImage = vi.fn(async () => undefined);
    const reorderLocalImages = vi.fn(async () => undefined);
    vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:one').mockReturnValueOnce('blob:two');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const first = new File(['one'], 'one.jpg', { type: 'image/jpeg' });
    const second = new File(['two'], 'two.jpg', { type: 'image/jpeg' });
    const view = render(<SourceEditor source={local} type="local" operations={{ ...operations, listLocalFiles: vi.fn(async () => [{ sourceId: 'local', id: 'one', name: 'one.jpg', type: first.type, size: first.size, blob: first, createdAt: 1 }, { sourceId: 'local', id: 'two', name: 'two.jpg', type: second.type, size: second.size, blob: second, createdAt: 2 }]), deleteLocalImage, reorderLocalImages }} onSave={vi.fn(async () => undefined)} onCancel={vi.fn()} onRefresh={vi.fn()} />);

    await screen.findByRole('img', { name: 'one.jpg' });
    await user.click(screen.getByRole('button', { name: '下移 one.jpg' }));
    expect(reorderLocalImages).toHaveBeenCalledWith('local', ['two', 'one']);
    await user.click(screen.getByRole('button', { name: '删除 one.jpg' }));
    expect(deleteLocalImage).toHaveBeenCalledWith('local', 'one');
    view.unmount();
    expect(revoke).toHaveBeenCalledWith('blob:one');
  });

  it('revokes every URL created by an initial gallery load that resolves after unmount', async () => {
    let resolveRecords!: (records: Awaited<ReturnType<NonNullable<SourceOperations['listLocalFiles']>>>) => void;
    const pending = new Promise<Awaited<ReturnType<NonNullable<SourceOperations['listLocalFiles']>>>>((resolve) => { resolveRecords = resolve; });
    const first = new File(['one'], 'one.jpg', { type: 'image/jpeg' });
    const second = new File(['two'], 'two.jpg', { type: 'image/jpeg' });
    vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:late-one').mockReturnValueOnce('blob:late-two');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const view = render(<SourceEditor source={local} type="local" operations={{ ...operations, listLocalFiles: vi.fn(() => pending) }} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    view.unmount();

    resolveRecords([{ sourceId: local.id, id: 'one', name: 'one.jpg', type: first.type, size: first.size, blob: first, createdAt: 1 }, { sourceId: local.id, id: 'two', name: 'two.jpg', type: second.type, size: second.size, blob: second, createdAt: 2 }]);

    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(2));
    expect(revoke).toHaveBeenCalledWith('blob:late-one'); expect(revoke).toHaveBeenCalledWith('blob:late-two');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('keeps the newer overlapping gallery load and revokes only URLs produced by the stale result', async () => {
    let resolveInitial!: (records: Awaited<ReturnType<NonNullable<SourceOperations['listLocalFiles']>>>) => void;
    const initial = new Promise<Awaited<ReturnType<NonNullable<SourceOperations['listLocalFiles']>>>>((resolve) => { resolveInitial = resolve; });
    const oldFile = new File(['old'], 'old.jpg', { type: 'image/jpeg' });
    const newFile = new File(['new'], 'new.jpg', { type: 'image/jpeg' });
    const listLocalFiles = vi.fn()
      .mockImplementationOnce(() => initial)
      .mockResolvedValueOnce([{ sourceId: local.id, id: 'new', name: 'new.jpg', type: newFile.type, size: newFile.size, blob: newFile, createdAt: 2 }]);
    vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:new-current').mockReturnValueOnce('blob:old-stale');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const custom = { ...operations, listLocalFiles, importLocal: vi.fn(async () => ({ imported: 1, failures: [] })) };
    render(<SourceEditor source={local} type="local" operations={custom} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);

    await userEvent.setup().upload(screen.getByLabelText('导入本地图片'), newFile);
    await screen.findByRole('img', { name: 'new.jpg' });
    resolveInitial([{ sourceId: local.id, id: 'old', name: 'old.jpg', type: oldFile.type, size: oldFile.size, blob: oldFile, createdAt: 1 }]);

    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:old-stale'));
    expect(revoke).not.toHaveBeenCalledWith('blob:new-current');
    expect(screen.getByRole('img', { name: 'new.jpg' })).toHaveAttribute('src', 'blob:new-current');
    expect(screen.queryByRole('img', { name: 'old.jpg' })).not.toBeInTheDocument();
  });

  it('normalizes local IndexedDB list/import/delete/reorder rejections without unhandled optimistic state', async () => {
    const file = new File(['one'], 'one.jpg', { type: 'image/jpeg' });
    const record = { sourceId: local.id, id: 'one', name: 'one.jpg', type: file.type, size: file.size, blob: file, createdAt: 1 };
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:one'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const listFailure = render(<SourceEditor source={local} type="local" operations={{ ...operations, listLocalFiles: vi.fn(async () => { throw new Error('private'); }) }} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('无法读取本地图片')); listFailure.unmount();

    const importFailure = render(<SourceEditor source={local} type="local" operations={{ ...operations, listLocalFiles: vi.fn(async () => [record]), importLocal: vi.fn(async () => { throw new Error('private'); }) }} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    await screen.findByRole('img', { name: 'one.jpg' }); await userEvent.setup().upload(screen.getByLabelText('导入本地图片'), file);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('导入本地图片失败')); importFailure.unmount();

    const deleteFailure = render(<SourceEditor source={local} type="local" operations={{ ...operations, listLocalFiles: vi.fn(async () => [record]), deleteLocalImage: vi.fn(async () => { throw new Error('private'); }) }} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    await screen.findByRole('img', { name: 'one.jpg' }); await userEvent.setup().click(screen.getByRole('button', { name: '删除 one.jpg' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('删除本地图片失败')); expect(screen.getByRole('img', { name: 'one.jpg' })).toBeInTheDocument(); deleteFailure.unmount();

    const second = { ...record, id: 'two', name: 'two.jpg', createdAt: 2 };
    const reorderFailure = render(<SourceEditor source={local} type="local" operations={{ ...operations, listLocalFiles: vi.fn(async () => [record, second]), reorderLocalImages: vi.fn(async () => { throw new Error('private'); }) }} onSave={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} />);
    await screen.findByRole('img', { name: 'one.jpg' }); await userEvent.setup().click(screen.getByRole('button', { name: '下移 one.jpg' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('已恢复'));
    expect(screen.getAllByTitle(/\.jpg$/).map((node) => node.textContent)).toEqual(['one.jpg', 'two.jpg']); reorderFailure.unmount();
  });
});
