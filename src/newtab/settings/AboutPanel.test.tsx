import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultSettings } from '../../domain/defaults';
import type { DataClearResult } from '../dataClear';
import { LanguageProvider, useDocumentLocalization } from '../i18n';
import { AboutPanel } from './AboutPanel';

function LocalizedAboutPanel({ clearData }: { clearData?: () => Promise<DataClearResult> }) {
  useDocumentLocalization('en-US');
  return <LanguageProvider language="en-US"><AboutPanel version="0.1.0" clearData={clearData} onCleared={vi.fn()} /></LanguageProvider>;
}

afterEach(cleanup);

describe('AboutPanel', () => {
  it('shows the intended public repository and the bundled approved TMDB logo by default', () => {
    render(<AboutPanel version="0.1.0" onCleared={vi.fn()} />);

    expect(screen.getByRole('link', { name: '源码仓库' })).toHaveAttribute('href', 'https://github.com/mrjoechen/PicTab');
    expect(screen.getByRole('img', { name: 'TMDB' })).toHaveAttribute('src', '/assets/tmdb-blue-short.svg');
    expect(screen.getByRole('link', { name: 'TMDB 标识与归因规范' })).toHaveAttribute('href', 'https://www.themoviedb.org/about/logos-attribution');
  });

  it('shows accurate privacy, MIT license, TMDB policy, and safe official links', () => {
    render(<AboutPanel version="0.1.0" repositoryUrl={null} onCleared={vi.fn()} />);

    expect(screen.getByText('PicTab 0.1.0')).toBeInTheDocument();
    expect(screen.getByText(/不包含统计、遥测或跟踪/)).toBeInTheDocument();
    expect(screen.getByText(/持久化配置不会上传到 PicTab 基础设施/)).toBeInTheDocument();
    expect(screen.getByText(/城市或坐标发送给 Open-Meteo/)).toBeInTheDocument();
    expect(screen.getByText(/搜索控件会从内置搜索服务加载图标，提交后才把查询交给所选搜索引擎/)).toBeInTheDocument();
    expect(screen.getByText(/JSON API 会把配置的请求头发送给 API endpoint，并从你授权的图片主机或 CDN 下载图片/)).toBeInTheDocument();
    expect(screen.getByText(/在线图片 URL 会直接请求相应图片主机/)).toBeInTheDocument();
    expect(screen.getByText(/TMDB 会把 API 凭据发送给 TMDB API，并从 TMDB CDN 下载图片/)).toBeInTheDocument();
    expect(screen.getByText(/主动使用当前位置时.*BigDataCloud/)).toBeInTheDocument();
    expect(screen.getByText(/应用专用密码/)).toBeInTheDocument();
    expect(screen.getByText(/仓库地址尚未配置/)).toBeInTheDocument();
    expect(screen.getByText(/采用 MIT License 发布的开源软件/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看 MIT License' })).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.getByText('This product uses the TMDB API but is not endorsed or certified by TMDB.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '申请 TMDB API 凭据' })).toHaveAttribute('href', 'https://www.themoviedb.org/settings/api');
    expect(screen.getByRole('link', { name: 'TMDB 官方指南' })).toHaveAttribute('href', 'https://developer.themoviedb.org/v4/docs/getting-started');
    for (const link of screen.getAllByRole('link').filter((item) => item.getAttribute('target') === '_blank')) {
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
      expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    }
  });

  it('fully localizes About content and its clear-data dialog in English', async () => {
    const clear = vi.fn().mockResolvedValue({ ok: false, failures: ['weather cache', 'private implementation detail'] });
    render(<LocalizedAboutPanel clearData={clear} />);
    const user = userEvent.setup();

    expect(screen.getByRole('heading', { name: 'About and privacy' })).toBeInTheDocument();
    expect(screen.getByText(/contains no analytics, telemetry, or tracking/)).toBeInTheDocument();
    expect(screen.getByText(/contacts the third parties you choose/)).toBeInTheDocument();
    expect(screen.getByText(/Image-source credentials are stored in Chrome local storage/)).toBeInTheDocument();
    expect(screen.getByText(/Granted site access may remain/)).toBeInTheDocument();
    expect(screen.getByText(/TMDB content and trademarks belong/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View MIT License' })).toBeInTheDocument();
    expect(document.querySelector('.about-panel')?.textContent).not.toMatch(/[㐀-鿿]/);

    await user.click(screen.getByRole('button', { name: 'Clear all PicTab data' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Clear all PicTab data' });
    expect(within(dialog).getByText('Local images')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Confirm clear' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Weather cache and Some local data');
    expect(dialog.textContent).not.toMatch(/[㐀-鿿]/);
  });

  it('requires an explicit accessible confirmation, supports Escape, and restores trigger focus', async () => {
    render(<AboutPanel version="0.1.0" repositoryUrl={null} onCleared={vi.fn()} />);
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: '清除所有 PicTab 数据' });
    await user.click(trigger);
    const dialog = screen.getByRole('alertdialog', { name: '清除所有 PicTab 数据' });
    for (const label of ['设置与凭据', '本地图片', '远程图片缓存与目录', '天气缓存', '切换游标与清理日志']) expect(within(dialog).getByText(label)).toBeInTheDocument();
    expect(within(dialog).getByText(/不会删除 WebDAV 或 TMDB 上的远端内容/)).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('clears once, reports only safe aggregate failures, and returns defaults on success', async () => {
    const clear = vi.fn()
      .mockResolvedValueOnce({ ok: false, failures: ['weather cache'] })
      .mockResolvedValueOnce({ ok: true, settings: createDefaultSettings() });
    const onCleared = vi.fn();
    render(<AboutPanel version="0.1.0" repositoryUrl={null} clearData={clear} onCleared={onCleared} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '清除所有 PicTab 数据' }));
    await user.click(screen.getByRole('button', { name: '确认清除' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('天气缓存');
    expect(document.body.textContent).not.toContain('private');
    await user.click(screen.getByRole('button', { name: '确认清除' }));
    await waitFor(() => expect(onCleared).toHaveBeenCalledWith(createDefaultSettings()));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
