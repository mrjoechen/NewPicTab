# PicTab

PicTab 是一个极简 Chrome 新标签页扩展：背景图是主角，时间、日期、天气、搜索与快捷网址都可以独立关闭。图片源由用户添加，并可在本地图片、WebDAV、在线图片 URL、通用 JSON API 与 TMDB 之间切换。

> 本项目以源码可见、仅限非商业使用的方式提供，采用 [PolyForm Noncommercial 1.0.0](LICENSE)。它不是 OSI 定义的“开源软件”。

## 安装与开发

需要 Node.js `^20.19.0` 或 `>=22.12.0`、npm，以及 Chrome 111 或更新版本。代码仓库：[github.com/mrjoechen/PicTab](https://github.com/mrjoechen/PicTab)。

```bash
npm ci
npm run dev        # 普通 Vite 页面预览；不等同于扩展运行环境
npm run typecheck
npm test
npm run build
npm run check      # typecheck + unit tests + production build
npm run e2e:install # 首次运行 E2E 前安装 Playwright Chromium
npm run test:e2e   # 重新 build，再用临时 Chrome profile 加载未打包扩展
```

在 Chrome 中手动验证：

1. 运行 `npm run build`。
2. 打开 `chrome://extensions`，开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本仓库的 `dist` 目录。
4. 打开一个新标签页。Chrome 应跳转到 PicTab 的 `newtab.html`。

不要选择仓库根目录；Chrome 需要加载构建后的 `dist`。E2E 使用独立的临时浏览器 profile，不会连接或修改日常使用的 Chrome profile。为自动验证 Direct 源，测试会复制一份临时 `dist`，仅向该副本预授 `https://images.test/*` fixture 权限，并在页面内提供确定性 worker 响应；生产 `manifest.json` 不会被修改，也不会访问真实图片服务。失败产物位于已忽略的 `test-results/`；HTML 报告目录 `playwright-report/` 也不会进入版本控制。

## 功能

- 多图片源：本地上传、WebDAV、HTTPS 图片 URL、通用 JSON API、TMDB。
- 当前图片源即时切换，并在顺序/随机模式下浏览；远程源采用分窗目录与有界缓存。
- Fade、Slide、Ken Burns、None 四种切换效果，并尊重系统“减少动态效果”偏好。
- 时间与日期独立开关；天气默认手动选择城市，浏览器定位仅在用户明确点击后调用一次。
- Google、Bing、DuckDuckGo 或自定义 HTTPS 搜索模板。
- 用户手动添加、排序和删除的 HTTPS 快捷网址，可选本地图标。
- 无 PicTab 账号、服务端、统计、遥测或跟踪。

## 图片源

### 本地图片

选择或拖入 JPEG、PNG、WebP、GIF、AVIF。图片保存在当前 Chrome profile 的 IndexedDB 中，不会上传。删除图片源会同时删除对应本地图片；界面会先要求确认。

### WebDAV

填写 HTTPS 目录、用户名和密码，点击“测试连接”后才会请求该 WebDAV 地址的站点访问权限。PicTab 使用 `PROPFIND` 读取目录并按需 `GET` 图片，可选包含子目录。

建议为 PicTab 创建权限最小的应用专用密码，不要复用主账号密码。凭据保存在 `chrome.storage.local`，不会通过 Chrome Sync 同步，但它不是密码库：能访问已解锁浏览器 profile 的人可能读取配置。服务端应使用有效 HTTPS 证书并正确配置 CORS/WebDAV 方法。

### 在线图片 URL

逐条添加完整 HTTPS 图片地址和可选标签，例如：

```text
https://cdn.example.com/photos/forest-01.webp
https://cdn.example.com/photos/ocean-02.jpg
```

`example.com` 仅用于说明，请替换为你有权访问和展示的图片。点击测试时，PicTab 会一次性请求这些 URL 所属的精确 origin，而不是在安装时取得全网访问权。

### 通用 JSON API

安全示例 endpoint：`https://api.example.com/v1/wallpapers`。假设响应为：

```json
{
  "items": [
    {
      "id": "forest-01",
      "image": { "url": "https://cdn.example.com/forest-01.webp" },
      "title": "Forest",
      "author": "Example Studio"
    }
  ]
}
```

可配置：

- 图片数组路径：`items`
- 图片 URL 字段：`image.url`
- 稳定 ID：`id`
- 可选标题/作者：`title`、`author`
- 可选来源页、宽度、高度字段
- 可选分页参数与起始页
- 可选请求头（例如服务方要求的 `Authorization`）

测试分两次明确授权：先授权 API endpoint 并解析响应，再展示发现的图片 origin，用户点击“授权图片域并完成预览”后才请求这些 origin。请求头可能包含密钥，同样只存于本地 Chrome profile；诊断信息会递归隐藏密码、token、secret、authorization 与 API-key 类字段。只连接你信任、使用 HTTPS 且允许浏览器跨域请求的 API。

### TMDB

1. 在 [TMDB API 设置](https://www.themoviedb.org/settings/api)申请凭据，并阅读[官方入门指南](https://developer.themoviedb.org/v4/docs/getting-started)。
2. 在 PicTab 中粘贴自己的 API Read Access Token；项目不内置任何 TMDB 凭据。
3. 点击测试连接。测试成功后可选择电影/电视、官方 feed、官方 genre，以及语言、地区、年份/日期、最低评分、排序和页码等 Discover 分类。
4. PicTab 只在配置或使用 TMDB 图片源时请求 TMDB API 和图片 CDN。对 `https://api.themoviedb.org/*` 与 `https://image.tmdb.org/*` 的访问是 manifest 中的精确静态主机权限，但项目不内置任何 TMDB 凭据。

![TMDB official logo](public/assets/tmdb-blue-short.svg)

This product uses the TMDB API but is not endorsed or certified by TMDB.

TMDB 内容、商标与 API 使用还受 TMDB 自己的条款约束。PicTab 的非商业许可不会代替或扩大 TMDB 授予你的权限；发布或分发前请核对 [TMDB 标识与归因规范](https://www.themoviedb.org/about/logos-attribution)。

### 为什么没有启用 Unsplash / Pexels API

设置中保留两者的官方说明入口，但不接受 API key，也不提供适配器。原因是其公开 API 指南对把 API 内容用于壁纸/背景类产品有限制；PicTab 不用技术实现绕过供应商政策。请阅读 [Unsplash API Guidelines](https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines) 与 [Pexels API Documentation](https://www.pexels.com/api/documentation/)。

## 天气与定位

天气由 [Open-Meteo](https://open-meteo.com/en/docs) 提供。默认流程是用户输入城市并从搜索结果中选择；选择后只保存显示名称和经纬度。

“使用当前位置”是可选流程。PicTab 声明 Chrome 的 `geolocation` 权限以提供此能力，但页面加载、启用天气或手动城市模式都不会调用定位。只有用户明确点击“使用当前位置”时才调用 `navigator.geolocation.getCurrentPosition` 一次；操作系统或 Chrome 仍可能显示自己的定位确认。定位坐标会通过 BigDataCloud 的客户端反向地理编码接口转换为城市名称；识别失败时仍可使用坐标查询天气。

天气与位置名称涉及以下 origin：

- `https://api.open-meteo.com/*`：当前天气。
- `https://geocoding-api.open-meteo.com/*`：城市搜索。
- `https://api.bigdatacloud.net/*`：仅在主动定位时把当前设备坐标转换为城市名称。

天气请求会把选中的城市/坐标直接发送给 Open-Meteo。最近天气保存在本地，网络失败时可显示标记为过期的缓存结果。

## 权限说明

PicTab 没有命令快捷键。manifest 只为内置的 TMDB 和天气服务声明精确静态主机权限；WebDAV、在线图片 URL 和通用 JSON API 则在用户测试或启用图片源时，按实际配置请求精确 HTTPS origin。完整权限如下：

| 权限 | 类型 | 用途与触发时机 |
| --- | --- | --- |
| `storage` | 安装时声明 | 保存设置、凭据、天气缓存与运行游标到当前 Chrome profile。PicTab 不使用 `storage.sync`。 |
| `unlimitedStorage` | 安装时声明 | 允许用户选择的本地图片与远程图片缓存超出较小默认配额；PicTab 仍对远程缓存设置有界清理策略。 |
| `geolocation` | 安装时声明 | 仅提供“使用当前位置”按钮；只有明确点击后才调用一次浏览器定位。 |
| `favicon` | 安装时声明 | 通过 Chrome 内置 `_favicon` API 显示用户手动添加的快捷网址图标。 |
| TMDB 两个精确 origin | 安装时 host 权限 | 仅用于 TMDB API 与官方图片 CDN；只在配置或使用 TMDB 图片源时发起网络请求。 |
| Open-Meteo 两个精确 origin、BigDataCloud 一个精确 origin | 安装时 host 权限 | 用于城市搜索、天气和主动定位后的城市名称识别；只在用户使用对应功能时请求。 |
| `https://*/*` | 可选 host 权限声明 | 只是可申请范围，安装时不授予。测试或启用 WebDAV、在线图片 URL 或通用 JSON API 时，PicTab 从用户配置解析并批量请求当次所需的精确 HTTPS origin。Chrome 可在扩展详情中撤销已授予的站点访问权。 |

清除 PicTab 数据不会擅自撤销 Chrome 管理的站点访问权；如需撤销，请在 `chrome://extensions` → PicTab →“详情”→“网站访问权限”中操作。

## 隐私与数据清除

PicTab 没有自有服务器，不包含广告、统计、遥测或跟踪。数据流只发生在浏览器本地，或由你启用的功能直接访问对应第三方：

- 图片源访问 WebDAV/API/图片 CDN；TMDB 访问 TMDB API/CDN。
- 天气访问 Open-Meteo。
- 搜索控件会从内置搜索服务加载 favicon；提交搜索后，查询词才会交给所选搜索引擎。
- 点击快捷网址是普通网页导航。

本地图片位于 IndexedDB；远程图片字节位于 Cache Storage，目录/LRU 元数据位于 IndexedDB；设置与天气缓存位于 `chrome.storage.local`。远程缓存键使用不可逆摘要，不含凭据 URL。设置 → 关于 →“清除所有 PicTab 数据”会在二次确认后清除设置和凭据、本地图片、远程缓存与目录、天气缓存、切换游标和清理日志。它不会删除远端内容，也不会撤销 Chrome 站点权限。

## 架构

- `src/domain`：可迁移设置模型、切换状态、搜索与快捷网址规则。
- `src/sources`：本地、WebDAV、直接 URL、JSON API、TMDB 适配器；统一输出图片条目。
- `src/background`：Manifest V3 service worker，承担需 host 权限的网络、缓存与天气请求。
- `src/storage`：Chrome Storage、IndexedDB、Cache Storage 以及清理/恢复日志。
- `src/newtab`：React 新标签页、背景双层渲染、设置抽屉与隐私界面。
- `e2e`：使用临时 profile 加载 `dist` 的 Playwright 扩展测试；供应商场景只允许确定性 fixture，不使用真实密钥或定位。

## 真实服务手动检查清单

自动化测试不包含真实凭据、第三方账号或位置。准备发布前请在全新 Chrome profile 中手动验证：

- [ ] WebDAV：使用专用测试账号，完成连接、预览、子目录、刷新、离线缓存、清缓存与删除；确认日志/截图没有用户名或密码。
- [ ] TMDB：使用自己的 Read Token，完成测试、电影/电视切换、官方 feed/genre、Discover 筛选、刷新与归因展示；随后清除本地数据。
- [ ] 天气：手动城市搜索不会触发定位；点击“使用当前位置”才出现浏览器/系统定位流程；拒绝定位后页面仍可使用城市模式。
- [ ] 背景：方向键与“立即换图”可切换；Fade、Slide、Ken Burns、None 均工作；系统减少动态效果时退化为无动效。
- [ ] 离线：同一远程图片源在已有缓存时继续显示；无可用缓存时仍展示内置 fallback，设置入口始终可用。
- [ ] 清除：确认弹窗列出所有范围；清除后恢复首次使用状态，本地图片、远程缓存、天气和凭据均不可恢复。

## 许可

[LICENSE](LICENSE) 是从 PolyForm 官方的 [Noncommercial 1.0.0 plain text](https://polyformproject.org/licenses/noncommercial/1.0.0.txt) 采用的完整条款，并附项目的 `Required Notice`。允许的用途以许可证原文为准；商业使用需要另行取得许可。
