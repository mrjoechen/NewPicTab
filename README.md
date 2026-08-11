# PicTab

简体中文 | [English](README_EN.md)

PicTab 是一个以图片为主角的极简 Chrome 新标签页扩展。你可以自由组合本地与远程图片源，并按需显示时间、日期、天气、搜索和快捷网址。

> PicTab 采用 [MIT License](LICENSE) 开源，可自由使用、复制、修改和分发，包括商业用途；请保留版权与许可声明。

## 功能特色

- 支持本地图片、WebDAV、HTTPS 图片 URL、通用 JSON API 和 TMDB。
- 支持顺序或随机换图，可在打开新标签页时切换，也可按时间间隔自动切换。
- 提供淡入淡出、滑动、缓慢推移和无动效四种切换样式，并尊重系统的“减少动态效果”偏好。
- 时间、日期、天气、搜索和快捷网址均可独立开关。
- 内置 Google、Bing、DuckDuckGo 和 Baidu，也支持自定义 HTTPS 搜索模板。
- 快捷网址支持添加、排序、删除和自定义本地图标。
- 扩展图标和内置搜索引擎图标随安装包提供，首次绘制不依赖远程 favicon。
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
- 只有启用相应功能时，PicTab 才会直接请求你选择的图片源、TMDB、Open-Meteo 或 BigDataCloud。搜索图标随扩展内置，只有提交搜索后才会把查询交给所选搜索引擎。
- 天气默认通过城市查询；只有点击“使用当前位置”时才会调用一次浏览器定位，并通过 BigDataCloud 识别城市名称。
- “设置 → 关于 → 清除所有 PicTab 数据”可清除本地设置、凭据、图片与缓存，但不会删除远端内容或撤销 Chrome 管理的站点权限。

如需撤销站点权限，请前往 `chrome://extensions` → PicTab →“详情”→“网站访问权限”。

## 天气与定位

天气由 [Open-Meteo](https://open-meteo.com/en/docs) 提供。默认流程是用户输入城市并从搜索结果中选择；选择后只保存显示名称和经纬度。

“使用当前位置”是可选流程。PicTab 声明 Chrome 的 `geolocation` 权限以提供此能力，但页面加载、启用天气或手动城市模式都不会调用定位。只有用户明确点击“使用当前位置”时才调用 `navigator.geolocation.getCurrentPosition` 一次；操作系统或 Chrome 仍可能显示自己的定位确认。定位坐标会通过 BigDataCloud 的客户端反向地理编码接口转换为城市名称；识别失败时仍可使用坐标查询天气。

天气与位置名称涉及以下 origin：

- `https://api.open-meteo.com/*`：当前天气。
- `https://geocoding-api.open-meteo.com/*`：城市搜索。
- `https://api.bigdatacloud.net/*`：仅在主动定位时把当前设备坐标转换为城市名称。

天气请求会把选中的城市或坐标直接发送给 Open-Meteo。最近天气保存在本地，网络失败时可显示标记为过期的缓存结果。

## 权限明细

PicTab 没有命令快捷键。manifest 只为内置的 TMDB 和天气服务声明精确静态主机权限；WebDAV、在线图片 URL 和通用 JSON API 则在用户测试或启用图片源时，按实际配置请求精确 HTTPS origin。

| 权限 | 类型 | 用途与触发时机 |
| --- | --- | --- |
| `storage` | 安装时声明 | 保存设置、凭据、天气缓存与运行游标到当前 Chrome profile。PicTab 不使用 `storage.sync`。 |
| `unlimitedStorage` | 安装时声明 | 允许用户选择的本地图片与远程图片缓存超出较小默认配额；PicTab 仍对远程缓存设置有界清理策略。 |
| `geolocation` | 安装时声明 | 仅提供“使用当前位置”按钮；只有明确点击后才调用一次浏览器定位。 |
| `favicon` | 安装时声明 | 通过 Chrome 内置 `_favicon` API 显示用户手动添加的快捷网址图标。 |
| TMDB 两个精确 origin | 安装时 host 权限 | 仅用于 TMDB API 与官方图片 CDN；只在配置或使用 TMDB 图片源时发起网络请求。 |
| Open-Meteo 两个精确 origin、BigDataCloud 一个精确 origin | 安装时 host 权限 | 用于城市搜索、天气和主动定位后的城市名称识别；只在用户使用对应功能时请求。 |
| `https://*/*` | 可选 host 权限声明 | 只是可申请范围，安装时不授予。测试或启用 WebDAV、在线图片 URL 或通用 JSON API 时，PicTab 从用户配置解析并请求当次所需的精确 HTTPS origin。Chrome 可在扩展详情中撤销已授予的站点访问权。 |

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

TMDB 内容、商标与 API 使用受 TMDB 自身条款约束。PicTab 代码采用 MIT License，并不表示 TMDB 内容也适用该许可，也不会代替或扩大 TMDB 授予你的权限；发布或分发前请核对 TMDB 的标识与归因要求。

## 数据存储与清除

本地图片位于 IndexedDB；远程图片字节位于 Cache Storage，目录和 LRU 元数据位于 IndexedDB；设置、凭据与天气缓存位于 `chrome.storage.local`。远程缓存键使用不可逆摘要，不包含带凭据的 URL。

“设置 → 关于 → 清除所有 PicTab 数据”会在二次确认后清除设置和凭据、本地图片、远程缓存与目录、天气缓存、切换游标和清理日志。它不会删除 WebDAV、TMDB 或其他远端内容，也不会擅自撤销 Chrome 管理的站点访问权限。

## 架构

- `src/domain`：可迁移设置模型、切换状态、搜索与快捷网址规则。
- `src/sources`：本地、WebDAV、直接 URL、JSON API、TMDB 适配器；统一输出图片条目。
- `src/background`：Manifest V3 service worker，承担需要 host 权限的网络、缓存与天气请求。
- `src/storage`：Chrome Storage、IndexedDB、Cache Storage 以及清理和恢复日志。
- `src/newtab`：React 新标签页、背景双层渲染、设置抽屉与隐私界面。
- `e2e`：使用临时 profile 加载 `dist` 的 Playwright 扩展测试；供应商场景只允许确定性 fixture，不使用真实密钥或定位。

## 发布前手动检查

自动化测试不包含真实凭据、第三方账号或位置。准备发布前请在全新 Chrome profile 中手动验证：

- [ ] WebDAV：使用专用测试账号，完成连接、预览、子目录、刷新、离线缓存、清缓存与删除；确认日志和截图没有用户名或密码。
- [ ] TMDB：使用自己的 Read Token，完成测试、电影和电视切换、官方 feed、genre、Discover 筛选、刷新与归因展示；随后清除本地数据。
- [ ] 天气：手动城市搜索不会触发定位；点击“使用当前位置”才出现浏览器或系统定位流程；拒绝定位后页面仍可使用城市模式。
- [ ] 背景：方向键与“立即换图”可切换；Fade、Slide、Ken Burns、None 均工作；系统减少动态效果时退化为无动效。
- [ ] 离线：同一远程图片源在已有缓存时继续显示；无可用缓存时仍展示内置 fallback，设置入口始终可用。
- [ ] 清除：确认弹窗列出所有范围；清除后恢复首次使用状态，本地图片、远程缓存、天气和凭据均不可恢复。

## 许可

PicTab 采用 [MIT License](LICENSE)。该协议允许个人和组织使用、复制、修改、合并、发布、分发、再许可和销售软件副本，包括商业用途；条件是保留原始版权与许可声明。软件按“原样”提供，不附带任何明示或默示担保。第三方内容和服务仍受各自条款约束。
