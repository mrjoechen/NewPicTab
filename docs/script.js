const header = document.querySelector("[data-header]");
const languageToggle = document.querySelector("[data-language-toggle]");
const themeToggle = document.querySelector("[data-theme-toggle]");
const themeColor = document.querySelector('meta[name="theme-color"]');
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const translations = {
  zh: {
    title: "NewPicTab — 你的图片，才是新标签页的主角",
    description:
      "NewPicTab 是一个以图片为主角的极简 Chrome 新标签页扩展。支持本地图片、WebDAV、HTTPS、JSON API 与 TMDB，无广告、无追踪。",
    ogTitle: "NewPicTab — 你的图片，才是新标签页的主角",
    ogDescription: "用自己的图片、私有图床或电影背景，重新设计 Chrome 新标签页。",
    skipLink: "跳到主要内容",
    homeLabel: "NewPicTab 首页",
    pageToolsLabel: "页面工具",
    languageToggle: "切换到英文",
    support: "赞赏",
    supportLabel: "赞赏作者",
    themeToDark: "切换到夜间模式",
    themeToLight: "切换到日间模式",
    heroLabel: "Chrome 新标签页 · 免费开源",
    heroTitle: "你的图片，<br />才是新标签页的主角。",
    heroLead: "连接自己的图片来源，只显示真正需要的内容。没有广告，没有账号，数据留在你的浏览器里。",
    trustLine: "无广告 · 无账号 · MIT 开源",
    heroImageAlt: "NewPicTab 在明亮桌面环境中的新标签页效果",
    addChrome: "添加至 Chrome",
    viewSource: "查看源代码",
    featuresTitle: "只留下真正需要的。",
    featuresLead: "NewPicTab 把图片来源、页面组件和隐私控制收进一个安静的新标签页。",
    sourcesTitle: "连接你的图片",
    sourcesCopy: "支持本地图片、WebDAV、HTTPS、JSON API 与 TMDB。",
    controlTitle: "只显示你需要的",
    controlCopy: "时间、天气、搜索和快捷网址都可以独立开关。",
    privacyTitle: "默认尊重隐私",
    privacyCopy: "没有开发者服务器、广告、统计、遥测或跟踪。",
    privacyLink: "了解隐私设计",
    sourcesImageAlt: "NewPicTab 图片来源设置预览",
    sourcesCaption: "多种来源，一个图库。",
    controlImageAlt: "NewPicTab 页面组件设置预览",
    controlCaption: "需要什么，就留下什么。",
    installTitle: "从下一次新标签页开始。",
    installCopy: "免费使用，MIT 开源。直接从 Chrome 商店安装，或在 GitHub 查看源代码。",
    destinationsLabel: "前往 Chrome 商店或 GitHub",
    visitStoreLabel: "前往 Chrome Web Store 安装 NewPicTab",
    chromeBadgeAlt: "在 Chrome Web Store 中获取 NewPicTab",
    visitGithubLabel: "前往 GitHub 查看 NewPicTab",
    githubBadgeAlt: "在 GitHub 查看 NewPicTab 开源项目",
    feedback: "反馈",
    buyCoffee: "请作者喝杯咖啡",
  },
  en: {
    title: "NewPicTab — Your pictures belong on your new tab",
    description:
      "NewPicTab is a minimal Chrome new-tab extension for local images, WebDAV, HTTPS, JSON APIs, and TMDB — with no ads or tracking.",
    ogTitle: "NewPicTab — Your pictures belong on your new tab",
    ogDescription: "Redesign Chrome's new tab with your own pictures, private library, or movie backdrops.",
    skipLink: "Skip to main content",
    homeLabel: "NewPicTab home",
    pageToolsLabel: "Page tools",
    languageToggle: "Switch to Chinese",
    support: "Support",
    supportLabel: "Support the creator",
    themeToDark: "Switch to dark mode",
    themeToLight: "Switch to light mode",
    heroLabel: "Chrome new tab · Free and open source",
    heroTitle: "Your pictures.<br />Your new tab.",
    heroLead:
      "Connect your own image sources and keep only what matters. No ads, no account, and your data stays in your browser.",
    trustLine: "No ads · No account · MIT licensed",
    heroImageAlt: "NewPicTab shown on a laptop in a bright workspace",
    addChrome: "Add to Chrome",
    viewSource: "View source",
    featuresTitle: "Only what you need.",
    featuresLead: "NewPicTab brings image sources, page controls, and privacy into one quiet new tab.",
    sourcesTitle: "Connect your pictures",
    sourcesCopy: "Use local images, WebDAV, HTTPS, JSON APIs, or TMDB.",
    controlTitle: "Keep only what matters",
    controlCopy: "Toggle time, weather, search, and shortcuts independently.",
    privacyTitle: "Private by default",
    privacyCopy: "No developer server, ads, analytics, telemetry, or tracking.",
    privacyLink: "Read the privacy notes",
    sourcesImageAlt: "NewPicTab image source settings preview",
    sourcesCaption: "Many sources. One library.",
    controlImageAlt: "NewPicTab page control settings preview",
    controlCaption: "Keep what you need.",
    installTitle: "Start with your next new tab.",
    installCopy: "Free and MIT licensed. Install from the Chrome Web Store or explore the source on GitHub.",
    destinationsLabel: "Open the Chrome Web Store or GitHub",
    visitStoreLabel: "Install NewPicTab from the Chrome Web Store",
    chromeBadgeAlt: "Available in the Chrome Web Store",
    visitGithubLabel: "View NewPicTab on GitHub",
    githubBadgeAlt: "View the open-source NewPicTab project on GitHub",
    feedback: "Feedback",
    buyCoffee: "Buy the creator a coffee",
  },
};

const readStoredValue = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const storeValue = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The current visit still works when storage is unavailable.
  }
};

const savedLanguage = readStoredValue("newpictab-site-language");
let currentLanguage =
  savedLanguage === "zh" || savedLanguage === "en"
    ? savedLanguage
    : navigator.language.toLowerCase().startsWith("zh")
      ? "zh"
      : "en";

const currentCopy = () => translations[currentLanguage];
const getTheme = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

const applyTheme = (theme, persist = true) => {
  document.documentElement.dataset.theme = theme;
  themeColor?.setAttribute("content", theme === "dark" ? "#0b0b0d" : "#f5f5f7");
  const label = theme === "dark" ? currentCopy().themeToLight : currentCopy().themeToDark;
  themeToggle?.setAttribute("aria-label", label);
  themeToggle?.setAttribute("title", label);
  themeToggle?.setAttribute("aria-pressed", String(theme === "dark"));
  if (persist) storeValue("newpictab-site-theme", theme);
};

const applyLanguage = (language) => {
  currentLanguage = language;
  const copy = currentCopy();

  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.title = copy.title;

  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const value = copy[element.dataset.i18n];
    if (value !== undefined) element.innerHTML = value;
  });

  document.querySelectorAll("[data-i18n-aria]").forEach((element) => {
    const value = copy[element.dataset.i18nAria];
    if (value !== undefined) element.setAttribute("aria-label", value);
  });

  document.querySelectorAll("[data-i18n-alt]").forEach((element) => {
    const value = copy[element.dataset.i18nAlt];
    if (value !== undefined) element.setAttribute("alt", value);
  });

  document.querySelector('meta[name="description"]')?.setAttribute("content", copy.description);
  document.querySelector('meta[property="og:title"]')?.setAttribute("content", copy.ogTitle);
  document.querySelector('meta[property="og:description"]')?.setAttribute("content", copy.ogDescription);
  document
    .querySelector('meta[property="og:locale"]')
    ?.setAttribute("content", language === "zh" ? "zh_CN" : "en_US");

  languageToggle?.setAttribute("aria-label", copy.languageToggle);
  languageToggle?.setAttribute("title", copy.languageToggle);

  const privacyLink = document.querySelector(".privacy-link");
  if (privacyLink) {
    privacyLink.href =
      language === "zh"
        ? "https://github.com/mrjoechen/NewPicTab/blob/main/README_ZH.md#%E9%9A%90%E7%A7%81%E4%B8%8E%E6%9D%83%E9%99%90"
        : "https://github.com/mrjoechen/NewPicTab/blob/main/README.md#privacy-and-permissions";
  }

  applyTheme(getTheme(), false);
};

applyLanguage(currentLanguage);
applyTheme(getTheme(), false);

languageToggle?.addEventListener("click", () => {
  const language = currentLanguage === "zh" ? "en" : "zh";
  applyLanguage(language);
  storeValue("newpictab-site-language", language);
});

themeToggle?.addEventListener("click", () => {
  applyTheme(getTheme() === "dark" ? "light" : "dark");
});

const updateHeader = () => {
  header?.classList.toggle("is-scrolled", window.scrollY > 12);
};

updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

const revealItems = document.querySelectorAll("[data-reveal]");

if (reducedMotion.matches || !("IntersectionObserver" in window)) {
  revealItems.forEach((item) => item.classList.add("is-visible"));
} else {
  revealItems.forEach((item) => item.classList.add("reveal-pending"));
  const observer = new IntersectionObserver(
    (entries, revealObserver) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -6%", threshold: 0.08 },
  );
  revealItems.forEach((item) => observer.observe(item));
}

const year = document.querySelector("[data-year]");
if (year) year.textContent = String(new Date().getFullYear());
