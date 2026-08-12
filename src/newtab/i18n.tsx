import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react';

import type { InterfaceLanguage } from '../domain/types';

const LanguageContext = createContext<InterfaceLanguage>('zh-CN');

export function LanguageProvider({ language, children }: { language: InterfaceLanguage; children: ReactNode }) {
  return <LanguageContext.Provider value={language}>{children}</LanguageContext.Provider>;
}

export function useInterfaceLanguage(): InterfaceLanguage {
  return useContext(LanguageContext);
}

export function text(language: InterfaceLanguage, chinese: string, english: string): string {
  return language === 'zh-CN' ? chinese : english;
}

export function useText() {
  const language = useInterfaceLanguage();
  return {
    language,
    isEnglish: language === 'en-US',
    text: (chinese: string, english: string) => text(language, chinese, english)
  };
}

export function localizedList(items: readonly string[], language: InterfaceLanguage): string {
  return new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(items);
}

const ENGLISH_RUNTIME_MESSAGES: Record<string, string> = {
  '图片源后台服务暂不可用。': 'The image source background service is unavailable.',
  '图片源返回了无效结果。': 'The image source returned an invalid result.',
  '无法清理未完成的本地导入。': 'Unable to clean up an unfinished local import.',
  '本地导入仍在等待保存。': 'The local import is still waiting to be saved.',
  '无法删除图片源。': 'Unable to delete the image source.',
  '无法刷新图片源。': 'Unable to refresh the image source.',
  '无法清除缓存。': 'Unable to clear the cache.',
  '正在载入图片…': 'Loading images…',
  '连接正常。': 'Connection is healthy.',
  '刷新失败，正在使用缓存。': 'Refresh failed. Using cached images.',
  '无法载入图片，请检查配置后重试。': 'Unable to load images. Check the configuration and try again.',
  '未获得目标域名访问权限，请在浏览器权限窗口中允许后重试。': 'Access to the target domain was not granted. Allow it in the browser permission prompt and try again.',
  '暂时无法连接 TMDB API，请检查网络或代理后重试。': 'Unable to connect to the TMDB API. Check your network or proxy and try again.',
  '天气服务暂不可用。': 'The weather service is unavailable.',
  '暂时无法获取天气，请稍后重试。': 'Unable to get the weather right now. Try again later.',
  '天气服务繁忙，请稍后重试。': 'The weather service is busy. Try again later.',
  '天气服务暂时不可用。': 'The weather service is temporarily unavailable.',
  '天气服务返回了无法识别的数据。': 'The weather service returned unrecognized data.',
  '天气服务返回了不完整的数据。': 'The weather service returned incomplete data.',
  '天气服务返回的数据过大。': 'The weather service response is too large.',
  '暂时无法连接天气服务。': 'Unable to connect to the weather service.',
  '暂时无法识别当前位置。': 'Unable to identify the current location.',
  '位置服务返回的数据过大。': 'The location service response is too large.',
  '位置服务返回了无法识别的数据。': 'The location service returned unrecognized data.',
  '未能识别当前位置的城市。': 'Unable to identify the city for the current location.',
  '未能读取有效的位置。': 'Unable to read a valid location.',
  '请选择有效的天气位置。': 'Choose a valid weather location.',
  '请输入至少两个字符的城市名称。': 'Enter at least two characters for the city name.'
};

export function localizeRuntimeMessage(language: InterfaceLanguage, message: string): string {
  if (language === 'zh-CN') return message;
  return ENGLISH_RUNTIME_MESSAGES[message] ?? translateUiText(message);
}

const ENGLISH_UI_TEXT: Record<string, string> = {
  '显示': 'Display', '背景与动效': 'Background and motion', '只调整图片的出现方式，不遮挡画面。': 'Adjust how images appear without covering the scene.',
  '切换样式': 'Transition style', '淡入淡出': 'Fade', '滑动': 'Slide', '缓慢推移': 'Ken Burns', '无动效': 'No animation',
  '动效时长': 'Animation duration', '快速 · 0.3 秒': 'Fast · 0.3 seconds', '自然 · 0.7 秒': 'Natural · 0.7 seconds', '舒缓 · 1.2 秒': 'Relaxed · 1.2 seconds', '缓慢 · 2 秒': 'Slow · 2 seconds',
  '图片顺序': 'Image order', '随机': 'Shuffle', '顺序': 'Sequential', '换图时机': 'Change image', '每次打开新标签页': 'Each new tab', '按时间间隔': 'At an interval', '间隔分钟': 'Interval in minutes', '立即换图': 'Change image now', '换图': 'Change image',
  '搜索': 'Search', '搜索词会直接交给所选引擎，NewPicTab 不会记录。': 'Search terms go directly to the selected engine. NewPicTab does not record them.', '显示搜索': 'Show search', '搜索引擎': 'Search engine', '自定义': 'Custom', '搜索模板': 'Search template', '保存搜索模板': 'Save search template',
  '保存': 'Save', '无法保存搜索设置。': 'Unable to save search settings.',
  '小组件': 'Widgets', '时间日期': 'Time and date', '时间和日期': 'Time and Date', '时间与日期可以独立显示。': 'Time and date can be shown independently.', '显示时间': 'Show time', '时间格式': 'Time format', '24 小时': '24-hour', '12 小时': '12-hour', '显示秒数': 'Show seconds', '文字大小': 'Text size', '显示位置': 'Position', '左上': 'Top left', '顶部居中': 'Top center', '右上': 'Top right', '居中': 'Center', '左下': 'Bottom left', '底部居中': 'Bottom center', '右下': 'Bottom right', '显示日期': 'Show date', '显示农历': 'Show lunar date', '日期格式': 'Date format', '简短': 'Short', '标准': 'Medium', '详细': 'Long', '完整': 'Full', '日期语言': 'Date language', '跟随界面语言': 'Follow interface language', '简体中文': 'Simplified Chinese',
  '天气': 'Weather', '默认手动选择城市，也可主动使用浏览器定位。': 'Choose a city manually, or use browser location when requested.', '显示天气': 'Show weather', '轻微天气动效': 'Subtle weather animation', '当前显示的是缓存天气，网络恢复后会自动刷新。': 'Cached weather is shown and will refresh when the network returns.', '搜索城市': 'Search cities', '城市搜索结果': 'City search results', '定位仅在点击此按钮后读取一次，用来向 Open-Meteo 查询当地天气；NewPicTab 不会持续追踪位置。': 'Location is read once only after you click this button and is used to query local weather from Open-Meteo. NewPicTab does not continuously track your location.', '当前位置': 'Current location', '使用当前位置': 'Use current location', '定位': 'Locate', '请输入至少两个字符。': 'Enter at least two characters.', '未授予天气服务访问权限。': 'Weather service access was not granted.', '没有找到匹配的城市。': 'No matching cities found.', '暂时无法搜索城市。': 'Unable to search for cities right now.', '已选择城市。': 'City selected.', '未能读取位置，请改用城市。': 'Unable to read your location. Choose a city instead.', '已使用当前位置。': 'Using the current location.', '位置已保存，天气稍后自动刷新。': 'Location saved. Weather will refresh automatically.',
  '图库': 'Library', '图片源': 'Sources', '添加多个来源，随时切换当前展示的图库。': 'Add multiple sources and switch the displayed library at any time.', '还没有图片源': 'No image sources yet', '添加后，NewPicTab 会立即显示其中的图片。': 'After you add one, NewPicTab will display its images immediately.', '已停用': 'Disabled', '待检测': 'Not checked', '可用': 'Available', '检测中': 'Checking', '缓存可用': 'Cached', '不可用': 'Unavailable', '正在使用': 'In use', '图片数量待加载': 'Image count pending', '已启用': 'Enabled', '使用此源': 'Use this source', '使用': 'Use', '重命名': 'Rename', '命名': 'Rename', '配置': 'Configure', '测试': 'Test', '刷新': 'Refresh', '清除缓存': 'Clear cache', '缓存': 'Cache', '删除': 'Delete', '选择图片源类型': 'Choose image source type', '选择来源': 'Choose a source', '取消': 'Cancel', '本地图片': 'Local images', '从当前设备导入': 'Import from this device', '连接你的私有图库': 'Connect your private library', '在线图片 URL': 'Direct image URLs', '逐行添加 HTTPS 图片': 'Add HTTPS images one per row', '映射自定义接口字段': 'Map fields from a custom endpoint', '电影与电视背景图': 'Movie and TV backgrounds', '添加图片源': 'Add image source', '添加': 'Add',
  '正在测试连接…': 'Testing connection…', '正在刷新…': 'Refreshing…', '缓存已清除。': 'Cache cleared.', '连接正常。': 'Connection is healthy.', '无法清除缓存，请重试。': 'Unable to clear the cache. Try again.', '连接测试失败，请检查配置。': 'Connection test failed. Check the configuration.', '刷新失败，请重试。': 'Refresh failed. Try again.', '图片源已保存，但刷新失败。请重试。': 'The source was saved, but refresh failed. Try again.',
  '删除失败，配置仍然保留。请重试。': 'Delete failed. The configuration is still saved. Try again.', '这会永久删除保存在浏览器中的本地图片，无法恢复。': 'This permanently deletes local images stored in the browser and cannot be undone.', '这会移除配置和缓存，不会删除远端的原始图片。': 'This removes the configuration and cache without deleting original remote images.', '确认删除': 'Confirm delete', '正在删除…': 'Deleting…', '删除中': 'Deleting',
  '快捷网址': 'Shortcuts', '只显示你手动添加的 HTTPS 网址。': 'Only HTTPS websites you add manually are shown.', '显示快捷网址': 'Show shortcuts', '最多显示': 'Maximum shown', 'Dock 大小': 'Dock size', '添加快捷网址': 'Add shortcut', '已添加的快捷网址': 'Added shortcuts', '上移': 'Move up', '下移': 'Move down', '上': 'Up', '下': 'Down', '编辑': 'Edit', '编辑快捷网址': 'Edit shortcut', '名称': 'Name', '网址': 'URL', '自定义图标': 'Custom icon', '图标预览': 'Icon preview', '网站图标预览': 'Website icon preview', '移除图标': 'Remove icon', '移除': 'Remove', '保存快捷网址': 'Save shortcut', '无法保存快捷网址设置。': 'Unable to save shortcut settings.', '无法保存快捷网址。': 'Unable to save the shortcut.', '无法删除快捷网址。': 'Unable to delete the shortcut.', '无法调整快捷网址顺序。': 'Unable to reorder shortcuts.', '无法处理图标文件。': 'Unable to process the icon file.',
  '图标仅支持 PNG、JPEG 或 WebP。': 'Icons must be PNG, JPEG, or WebP.', '图标不能超过 128 KB。': 'Icons cannot exceed 128 KB.', '无法读取图标文件。': 'Unable to read the icon file.', '图标文件格式与声明类型不匹配。': 'The icon file format does not match its declared type.', '图标尺寸不能超过 1024 × 1024。': 'Icon dimensions cannot exceed 1024 × 1024.', '图标文件无法显示或读取超时。': 'The icon cannot be displayed or took too long to read.',
  '关于与隐私': 'About and privacy', '一张背景，一点时间，其余保持安静。': 'One background, a little time, and everything else stays quiet.', '隐私': 'Privacy', 'NewPicTab 不包含统计、遥测或跟踪，也没有 NewPicTab 服务器；持久化配置不会上传到 NewPicTab 基础设施。': 'NewPicTab contains no analytics, telemetry, or tracking and operates no NewPicTab servers. Persisted configuration is not uploaded to NewPicTab infrastructure.', '仅在启用对应功能时，NewPicTab 才会直接请求你选择的第三方：WebDAV 会把凭据发送给 WebDAV 服务；JSON API 会把配置的请求头发送给 API endpoint，并从你授权的图片主机或 CDN 下载图片；在线图片 URL 会直接请求相应图片主机；TMDB 会把 API 凭据发送给 TMDB API，并从 TMDB CDN 下载图片；天气会把城市或坐标发送给 Open-Meteo；主动使用当前位置时，坐标还会发送给 BigDataCloud 以识别城市名称；搜索引擎图标随扩展内置；只有提交搜索后才会把查询交给所选搜索引擎；快捷网址则进行普通网页导航。': 'NewPicTab contacts the third parties you choose only when you enable the corresponding feature: WebDAV sends credentials to the WebDAV service; JSON API sends configured request headers to the API endpoint and downloads images from image hosts or CDNs you authorize; direct image URLs contact their respective image hosts; TMDB sends API credentials to the TMDB API and downloads images from the TMDB CDN; weather sends a city or coordinates to Open-Meteo; when you explicitly use your current location, coordinates are also sent to BigDataCloud to identify the city name; search-engine icons are bundled with the extension, and the selected search engine receives a query only after submission; shortcuts perform ordinary web navigation.', '图片源凭据保存在 Chrome 本地存储；这能避免浏览器同步，但无法防止可访问你已解锁浏览器配置文件的人读取。WebDAV 推荐使用应用专用密码。': 'Image-source credentials are stored in Chrome local storage. This prevents browser sync but cannot prevent someone with access to your unlocked browser profile from reading them. Use an app-specific password for WebDAV.', '已授予的站点访问权限可能继续保留，直到你在 Chrome 扩展设置中移除；清除数据不会擅自撤销权限。': 'Granted site access may remain until you remove it in Chrome extension settings. Clearing data does not automatically revoke permissions.', '源码与许可': 'Source and license', 'NewPicTab 是采用 MIT License 发布的开源软件，可自由使用、修改和分发，包括商业用途；分发时须保留版权与许可声明。': 'NewPicTab is open-source software released under the MIT License. You may use, modify, and distribute it, including for commercial purposes, provided that the copyright and license notices are retained.', '查看 MIT License': 'View MIT License', '源码仓库': 'Source repository', '仓库地址尚未配置。': 'The repository URL is not configured.', '支持作者': 'Support the author', '申请 TMDB API 凭据': 'Apply for TMDB API credentials', 'TMDB 官方指南': 'Official TMDB guide', 'TMDB 标识与归因规范': 'TMDB logo and attribution guidelines', 'TMDB 内容与商标归其各自权利人所有；NewPicTab 未内置 API 凭据。': 'TMDB content and trademarks belong to their respective rights holders. NewPicTab does not include API credentials.', '清除数据': 'Clear data', '移除 NewPicTab 在此浏览器配置文件中的设置、凭据、图片与运行记录。': 'Remove NewPicTab settings, credentials, images, and runtime records from this browser profile.', '清除所有 NewPicTab 数据': 'Clear all NewPicTab data', '清除': 'Clear', '将从当前浏览器配置文件永久移除：': 'The following will be permanently removed from this browser profile:', '设置与凭据': 'Settings and credentials', '远程图片缓存与目录': 'Remote image cache and catalog', '天气缓存': 'Weather cache', '切换游标与清理日志': 'Rotation cursors and cleanup journals', '不会删除 WebDAV 或 TMDB 上的远端内容。此操作无法撤销。': 'Remote content on WebDAV or TMDB will not be deleted. This action cannot be undone.', '正在清除…': 'Clearing…', '确认清除': 'Confirm clear', '清除中': 'Clearing', '未知版本': 'Unknown version',
  '返回': 'Back', '图片源配置': 'Source configuration', '当前图片源': 'Current source', '管理本地图片': 'Manage local images', '管理在线图片 URL': 'Manage direct image URLs', '管理 JSON API': 'Manage JSON API', '导入本地图片': 'Import local images', '选择文件或拖到这里；图片只保存在当前浏览器中。': 'Choose files or drop them here. Images are stored only in this browser.', '修改目标文件夹': 'Change target folder', '打开中': 'Opening', '刷新预览': 'Refresh preview', '刷新中': 'Refreshing', '编辑完整配置': 'Edit full configuration', '图片预览': 'Image preview', '暂无可预览图片': 'No preview images available', '删除图片源': 'Delete source', '编辑图片源': 'Edit source', '图片源名称': 'Source name', '例如：家庭相册': 'For example: Family album',
  '密码会保存在当前浏览器配置中；这不是密码库，任何能解锁此浏览器个人资料的人都可能恢复它。': 'The password is stored in this browser profile. This is not a password vault; anyone who can unlock the profile may be able to recover it.', 'WebDAV 地址': 'WebDAV URL', '用户名': 'Username', '密码': 'Password', '包含子文件夹': 'Include subfolders', '在线图片': 'Online images', '标签': 'Label', '请求头会保存在当前浏览器配置中；这不是密码库，任何能解锁此浏览器个人资料的人都可能恢复其中的密钥。': 'Request headers are stored in this browser profile. This is not a password vault; anyone who can unlock the profile may be able to recover secrets.', 'API 地址': 'API URL', '请求头': 'Request headers', '值': 'Value', '隐藏': 'Hide', '图片数组路径': 'Image array path', '图片 URL 字段': 'Image URL field', '稳定 ID 字段（可选）': 'Stable ID field (optional)', '标题字段（可选）': 'Title field (optional)', '作者字段（可选）': 'Author field (optional)', '来源页面字段（可选）': 'Source page field (optional)', '宽度字段（可选）': 'Width field (optional)', '高度字段（可选）': 'Height field (optional)', '起始页': 'Starting page', '分页参数（可选）': 'Page parameter (optional)', '使用你的 TMDB API Read Token。密钥仅保存在本机。': 'Use your TMDB API Read Token. The credential is stored only on this device.', '申请 API Key': 'Apply for an API key', '查看接入指南': 'View integration guide', '媒体类型': 'Media type', '电影': 'Movie', '电视节目': 'TV show', '内容分类': 'Content feed', '官方分类': 'Official genre', '全部类型': 'All genres', '语言': 'Language', '默认语言': 'Default language', '地区': 'Region', '全部地区': 'All regions', '上映年份': 'Release year', '首播年份': 'First air year', '上映日期从': 'Release date from', '首播日期从': 'First air date from', '上映日期至': 'Release date to', '首播日期至': 'First air date to', '最低评分': 'Minimum rating', '排序': 'Sort', '结果页': 'Result page',
  '测试连接': 'Test connection', '正在测试…': 'Testing…', '测试中': 'Testing', '测试 API': 'Test API', '正在测试 API…': 'Testing API…', '授权图片域并完成预览': 'Authorize image hosts and finish preview', '正在完成预览…': 'Finishing preview…', '预览': 'Preview', '预览中': 'Previewing', '保存并使用': 'Save and use', '连接预览': 'Connection preview', '图片预览缩略图': 'Image preview thumbnail', '正在加载更多预览…': 'Loading more previews…', '正在加载图片预览…': 'Loading image preview…', '加载更多预览': 'Load more previews', '加载更多': 'Load more', '缩略图加载中': 'Loading thumbnail',
  '选择 WebDAV 文件夹': 'Choose WebDAV folder', '取消选择': 'Cancel selection', 'WebDAV 文件夹层级': 'WebDAV folder hierarchy', '当前文件夹路径': 'Current folder path', '根目录': 'Root', '子文件夹': 'Subfolders', '当前层没有子文件夹': 'No subfolders at this level', '确认选择': 'Confirm selection', '正在确认选择…': 'Confirming selection…', '加载中': 'Loading', '图片源配置摘要': 'Source configuration summary', '目标文件夹': 'Target folder', '未填写': 'Not set', '已保存': 'Saved', '包含': 'Included', '不包含': 'Not included', '图片域': 'Image hosts', '跟随 API 地址': 'Same as API URL', 'API Token': 'API token', '存储位置': 'Storage location', '当前浏览器': 'This browser',
  '热门电影': 'Popular movies', '高分电影': 'Top-rated movies', '正在上映': 'Now playing', '即将上映': 'Upcoming', '今日趋势': 'Trending today', '本周趋势': 'Trending this week', '发现': 'Discover', '热门剧集': 'Popular TV shows', '高分剧集': 'Top-rated TV shows', '今日播出': 'Airing today', '正在播出': 'On the air',
  '请填写图片源名称。': 'Enter a source name.', '配置无效。': 'The configuration is invalid.', '无法读取本地图片，请重试。': 'Unable to read local images. Try again.', '本地清理失败，请重试后再导入图片。': 'Local cleanup failed. Try again before importing images.', '正在刷新图片预览…': 'Refreshing image preview…', '当前图片源没有可预览图片。': 'This source has no preview images.', '加载图片预览失败，请重试。': 'Unable to load the image preview. Try again.', '文件夹已选择，当前文件夹没有可预览图片。': 'Folder selected. It has no preview images.', '目标文件夹无效，请重新选择。': 'The target folder is invalid. Choose it again.', '正在打开文件夹…': 'Opening folder…', 'WebDAV 返回了无效的安全测试结果。': 'WebDAV returned an invalid security test result.', '已进入文件夹，可继续选择下一层。': 'Folder opened. You can continue to the next level.', '已进入文件夹，当前层没有子文件夹。': 'Folder opened. This level has no subfolders.', '打开文件夹失败，请重试。': 'Unable to open the folder. Try again.', '目标文件夹无效，请重新测试。': 'The target folder is invalid. Test again.', '正在加载所选文件夹的图片…': 'Loading images from the selected folder…', '加载所选文件夹图片失败，请重试。': 'Unable to load images from the selected folder. Try again.', '请在浏览器弹出的权限窗口中允许访问目标域名，之后会自动继续测试。': 'Allow access to the target domain in the browser permission prompt. Testing will then continue automatically.', 'WebDAV 地址无效。': 'The WebDAV URL is invalid.', 'WebDAV 文件夹路径无效。': 'The WebDAV folder path is invalid.', '连接成功。请选择目标文件夹。': 'Connected. Choose a target folder.', '连接成功。当前文件夹没有子文件夹，可直接确认当前文件夹。': 'Connected. This folder has no subfolders, so you can confirm it directly.', '连接成功。正在加载配置选项…': 'Connected. Loading configuration options…', '连接成功，但配置选项加载失败，请重试测试。': 'Connected, but configuration options could not be loaded. Test again.', '连接成功。': 'Connected.', '连接测试失败，请检查配置后重试。': 'Connection test failed. Check the configuration and try again.', 'API 返回了无效的安全测试结果。': 'The API returned an invalid security test result.', 'API 测试失败，请检查配置后重试。': 'API test failed. Check the configuration and try again.', '图片域授权或预览失败，请重试。': 'Image host authorization or preview failed. Try again.', '请先测试 TMDB 连接。': 'Test the TMDB connection first.', '请先完成 API 测试和图片域授权。': 'Complete the API test and image host authorization first.', '请先导入至少一张有效图片。': 'Import at least one valid image first.', '保存失败，请重试。': 'Save failed. Try again.', '导入本地图片失败，请重试。': 'Unable to import local images. Try again.', '删除本地图片失败，请重试。': 'Unable to delete the local image. Try again.', '调整图片顺序失败，已恢复。': 'Unable to reorder images. The previous order was restored.', '加载更多图片预览失败，请重试。': 'Unable to load more image previews. Try again.'
};

const ENGLISH_DYNAMIC_TEXT: Array<[RegExp, (...matches: string[]) => string]> = [
  [/^删除(.+)$/, (_all, name) => `Delete ${name}`], [/^重命名 (.+)$/, (_all, name) => `Rename ${name}`], [/^编辑配置 (.+)$/, (_all, name) => `Configure ${name}`], [/^测试 (.+)$/, (_all, name) => `Test ${name}`], [/^刷新 (.+)$/, (_all, name) => `Refresh ${name}`], [/^清除缓存 (.+)$/, (_all, name) => `Clear cache for ${name}`],
  [/^图片源状态：(.+)$/, (_all, state) => `Source status: ${translateUiText(state)}`], [/^(\d+) 张图片$/, (_all, count) => `${count} images`], [/^最多可添加 (\d+) 个快捷网址。$/, (_all, count) => `You can add up to ${count} shortcuts.`],
  [/^上移 (.+)$/, (_all, name) => `Move ${name} up`], [/^下移 (.+)$/, (_all, name) => `Move ${name} down`], [/^编辑 (.+)$/, (_all, name) => `Edit ${name}`], [/^打开 (.+)$/, (_all, name) => `Open ${name}`], [/^选择 (.+)$/, (_all, name) => `Choose ${name}`],
  [/^打开文件夹 (.+)$/, (_all, name) => `Open folder ${name}`], [/^当前路径：(.+)$/, (_all, path) => `Current path: ${path}`], [/^图片 URL (\d+)$/, (_all, index) => `Image URL ${index}`], [/^标签 (\d+)（可选）$/, (_all, index) => `Label ${index} (optional)`], [/^上移图片 (\d+)$/, (_all, index) => `Move image ${index} up`], [/^下移图片 (\d+)$/, (_all, index) => `Move image ${index} down`], [/^删除图片 (\d+)$/, (_all, index) => `Delete image ${index}`],
  [/^已加载 (\d+) 张预览。?$/, (_all, count) => `Loaded ${count} preview images.`], [/^连接成功，已预览 (\d+) 张图片。$/, (_all, count) => `Connected. Previewing ${count} images.`], [/^已导入 (\d+) 张图片。$/, (_all, count) => `Imported ${count} images.`]
];

function translateUiText(value: string): string {
  const exact = ENGLISH_UI_TEXT[value] ?? ENGLISH_RUNTIME_MESSAGES[value];
  if (exact) return exact;
  for (const [pattern, translate] of ENGLISH_DYNAMIC_TEXT) {
    const match = value.match(pattern);
    if (match) return translate(...match);
  }
  return value;
}

const originalText = new WeakMap<Text, string>();
const originalAttributes = new WeakMap<Element, Map<string, string>>();
const LOCALIZED_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'] as const;
const USER_CONTENT_SELECTOR = '.source-card h3, .source-manager__overview h3, .local-gallery__item, .shortcut-list__name, .weather-current-location, .webdav-picker__crumb:not(:first-child), .webdav-picker__folder span, .weather-results strong, .weather-results li span, .source-preview img';

export function useDocumentLocalization(language: InterfaceLanguage): void {
  useLayoutEffect(() => {
    let scheduled = false;
    let active = true;
    const process = () => {
      scheduled = false;
      if (active && typeof document !== 'undefined') localizeDocument(document.body, language);
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(process);
    };
    process();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...LOCALIZED_ATTRIBUTES] });
    return () => { active = false; observer.disconnect(); };
  }, [language]);
}

function localizeDocument(root: HTMLElement, language: InterfaceLanguage): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const node = current as Text;
    const parent = node.parentElement;
    if (!parent || parent.closest(USER_CONTENT_SELECTOR) || ['SCRIPT', 'STYLE'].includes(parent.tagName)) continue;
    localizeTextNode(node, language);
  }
  if (!root.closest(USER_CONTENT_SELECTOR)) localizeElementAttributes(root, language);
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    if (element.closest(USER_CONTENT_SELECTOR)) continue;
    localizeElementAttributes(element, language);
  }
}

function localizeTextNode(node: Text, language: InterfaceLanguage): void {
  const current = node.data;
  const stored = originalText.get(node);
  if (language === 'zh-CN') {
    if (stored !== undefined) { if (node.data !== stored) node.data = stored; originalText.delete(node); }
    return;
  }
  const expected = stored === undefined ? undefined : translateUiText(stored.trim());
  const whitespace = current.match(/^\s*/)?.[0] ?? '';
  const trailing = current.match(/\s*$/)?.[0] ?? '';
  const trimmed = current.trim();
  if (!trimmed) return;
  const source = stored === undefined || trimmed !== expected ? trimmed : stored;
  originalText.set(node, source);
  const translated = `${whitespace}${translateUiText(source)}${trailing}`;
  if (node.data !== translated) node.data = translated;
}

function localizeElementAttributes(element: Element, language: InterfaceLanguage): void {
  let stored = originalAttributes.get(element);
  for (const attribute of LOCALIZED_ATTRIBUTES) {
    const current = element.getAttribute(attribute);
    const source = stored?.get(attribute);
    if (language === 'zh-CN') {
      if (source !== undefined && current !== source) element.setAttribute(attribute, source);
      continue;
    }
    if (current === null) continue;
    const nextSource = source === undefined || current !== translateUiText(source) ? current : source;
    stored ??= new Map(); stored.set(attribute, nextSource);
    const translated = translateUiText(nextSource);
    if (current !== translated) element.setAttribute(attribute, translated);
  }
  if (stored) originalAttributes.set(element, stored);
}
