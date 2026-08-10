# PicTab

简体中文 | [English](README_EN.md)

PicTab 是一个以图片为主角的极简 Chrome 新标签页扩展。你可以自由组合本地与远程图片源，并按需显示时间、日期、天气、搜索和快捷网址。

> PicTab 采用 [MIT License](LICENSE) 开源，可自由使用、复制、修改和分发；请保留版权与许可声明。

## 功能特色

- 支持本地图片、WebDAV、HTTPS 图片 URL、通用 JSON API 和 TMDB。
- 支持顺序或随机换图，可在打开新标签页时切换，也可按时间间隔自动切换。
- 提供淡入淡出、滑动、缓慢推移和无动效四种切换样式，并尊重系统的“减少动态效果”偏好。
- 时间、日期、天气、搜索和快捷网址均可独立开关。
- 内置 Google、Bing、DuckDuckGo 和 Baidu，也支持自定义 HTTPS 搜索模板。
- 快捷网址支持添加、排序、删除和自定义本地图标。
- 无 PicTab 账号、服务端、广告、统计、遥测或跟踪。

## 安装

### 从 Release 下载

1. 打开 [Releases 页面](https://github.com/mrjoechen/PicTab/releases)。
2. 下载最新版本的 zip 发布包。
3. 将 zip 解压到本地目录。
4. 打开 `chrome://extensions`。
5. 开启右上角的“开发者模式”。
6. 点击“加载已解压的扩展程序”。
7. 选择解压后的扩展目录。
8. 打开一个新标签页。

> Chrome 不能直接加载 zip 文件，请先解压后再选择目录。

### 从源码构建

从源码构建并安装 PicTab，需要：

- Chrome 111 或更高版本
- Node.js `^20.19.0` 或 `>=22.12.0`
- npm

```bash
git clone https://github.com/mrjoechen/PicTab.git
cd PicTab
npm ci
npm run build
```

然后在 Chrome 中加载扩展：

1. 打开 `chrome://extensions`。
2. 开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择项目构建生成的 `dist` 目录。
5. 打开一个新标签页。

> 请加载 `dist`，不要选择仓库根目录。

## 图片源

| 类型 | 说明 |
| --- | --- |
| 本地图片 | 支持 JPEG、PNG、WebP、GIF 和 AVIF；图片仅保存在当前 Chrome profile 中。 |
| WebDAV | 读取 HTTPS WebDAV 目录，可选择子目录；建议使用权限最小的应用专用密码。 |
| 在线图片 URL | 添加一个或多个完整的 HTTPS 图片地址。 |
| 通用 JSON API | 从 HTTPS API 响应中映射图片 URL、标题、作者等字段，可配置分页和请求头。 |
| TMDB | 使用你自己的 API Read Access Token 浏览电影或电视背景图；项目不内置凭据。 |

用户配置的 WebDAV、在线图片 URL 和 JSON API 会在测试或启用时申请所需的精确 HTTPS origin 权限，而不是在安装时获得全网访问权。

## 隐私与权限

- 设置、凭据、图片与缓存保存在当前 Chrome profile，不使用 Chrome Sync，也不会上传到 PicTab 服务器。
- WebDAV 密码、JSON API 请求头和 TMDB token 存储在 `chrome.storage.local`；它不是密码库，请勿复用主账号密码。
- 只有启用相应功能时，PicTab 才会直接请求你选择的图片源、TMDB、Open-Meteo、BigDataCloud 或搜索服务。
- 天气默认通过城市查询；只有点击“使用当前位置”时才会调用一次浏览器定位，并通过 BigDataCloud 识别城市名称。
- “设置 → 关于 → 清除所有 PicTab 数据”可清除本地设置、凭据、图片与缓存，但不会删除远端内容或撤销 Chrome 管理的站点权限。

如需撤销站点权限，请前往 `chrome://extensions` → PicTab →“详情”→“网站访问权限”。

## 本地开发

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动普通 Vite 页面预览；不等同于扩展运行环境。 |
| `npm run build` | 类型检查并生成可加载的 `dist`。 |
| `npm test` | 运行单元测试。 |
| `npm run check` | 依次运行类型检查、单元测试和生产构建。 |
| `npm run e2e:install` | 首次运行 E2E 前安装 Playwright Chromium。 |
| `npm run test:e2e` | 构建并运行 Chrome 扩展 E2E 测试。 |

## TMDB 声明

使用 TMDB 图片源需要你自己的 [API Read Access Token](https://www.themoviedb.org/settings/api)。配置前请阅读 [TMDB 官方入门指南](https://developer.themoviedb.org/v4/docs/getting-started)和[标识与归因规范](https://www.themoviedb.org/about/logos-attribution)。

![TMDB official logo](public/assets/tmdb-blue-short.svg)

This product uses the TMDB API but is not endorsed or certified by TMDB.

TMDB 内容、商标与 API 使用受 TMDB 条款约束；PicTab 的许可不会扩大 TMDB 授予你的权限。

## 许可

PicTab 采用 [MIT License](LICENSE)。你可以自由使用、复制、修改、合并、发布、分发、再许可或销售本软件副本；请保留版权与许可声明。TMDB 内容、商标和 API 使用仍受 TMDB 自身条款约束。
