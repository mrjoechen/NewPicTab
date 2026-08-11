# Donation, GitHub, and README Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe, branded Ko-fi and GitHub links to PicTab's About and settings-header UI, and document the extension with a Ko-fi badge plus two equal-size local preview images in both README files.

**Architecture:** Centralize the repository and donation destinations as project constants, keep the donation URL behind the About panel's external-host validation, and reuse the bundled Ko-fi WebP in both the About panel and settings header. Preserve the close button as the first focusable header action in DOM order while using CSS order for the requested visual sequence. Process the two user screenshots deterministically into documentation-only JPEG assets, reference them from parallel English and Chinese preview sections, and use the corrected Shields.io badge HTML in both README files.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, CSS, Markdown, macOS `sips`.

**Delivery constraint:** Do not commit implementation code, README changes, or image assets. Leave all implementation changes in the working tree for user review.

---

### Task 1: Add the About-panel donation link with TDD

**Files:**
- Modify: `src/newtab/settings/AboutPanel.test.tsx`
- Modify: `src/newtab/settings/AboutPanel.tsx`
- Modify: `src/newtab/components/Icon.tsx`
- Modify: `src/newtab/i18n.tsx`
- Modify: `src/newtab/styles.css`

- [ ] **Step 1: Write the failing About-panel test**

Add this test inside `describe('AboutPanel', ...)`:

```tsx
it('offers a safe Ko-fi support link', () => {
  render(<AboutPanel version="0.1.0" onCleared={vi.fn()} />);

  const support = screen.getByRole('link', { name: '支持作者' });
  expect(support).toHaveAttribute('href', 'https://ko-fi.com/joechen');
  expect(support).toHaveAttribute('target', '_blank');
  expect(support).toHaveAttribute('rel', expect.stringContaining('noopener'));
  expect(support).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
});
```

In the English-localization test, add:

```tsx
expect(screen.getByRole('link', { name: 'Support the author' })).toBeInTheDocument();
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- src/newtab/settings/AboutPanel.test.tsx
```

Expected: FAIL because no link with accessible name `支持作者` exists.

- [ ] **Step 3: Implement the minimal donation link**

In `AboutPanel.tsx`, add the trusted URL and host:

```tsx
const DONATION_URL = 'https://ko-fi.com/joechen';
const EXTERNAL_HOSTS = new Set(['www.themoviedb.org', 'developer.themoviedb.org', 'github.com', 'gitlab.com', 'codeberg.org', 'ko-fi.com']);
```

Extend `ExternalLink` to accept an optional class name:

```tsx
function ExternalLink({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  const safe = safeExternalUrl(href);
  return safe ? <a className={className} href={safe} target="_blank" rel="noopener noreferrer">{children}</a> : null;
}
```

Append this link to the “源码与许可” `.about-links` container:

```tsx
<ExternalLink href={DONATION_URL} className="about-link--with-icon"><Icon name="coffee" /><span>支持作者</span></ExternalLink>
```

Add `coffee` to `IconName` and `iconPath` in `Icon.tsx`:

```tsx
case 'coffee': return <><path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z" /><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17" /><path d="M7 4v1M11 3v2M15 4v1" /></>;
```

Add the localization entry in `ENGLISH_UI_TEXT` in `i18n.tsx`:

```tsx
'支持作者': 'Support the author',
```

Add the focused layout rule in `styles.css`:

```css
.about-links .about-link--with-icon { display: inline-flex; align-items: center; gap: 7px; }
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npm test -- src/newtab/settings/AboutPanel.test.tsx
```

Expected: all `AboutPanel` tests PASS.

### Task 2: Add the settings-header GitHub link with TDD

**Files:**
- Modify: `src/newtab/settings/SettingsDrawer.test.tsx`
- Modify: `src/newtab/settings/SettingsDrawer.tsx`
- Modify: `src/newtab/components/Icon.tsx`
- Modify: `src/newtab/styles.css`

- [ ] **Step 1: Write the failing settings-header test**

Add this test inside `describe('SettingsDrawer', ...)`:

```tsx
it('links to the public GitHub project from the settings header', async () => {
  render(<SettingsDrawer settings={createDefaultSettings()} onUpdate={vi.fn()} onChangeImage={vi.fn()} />);
  await userEvent.setup().click(screen.getByRole('button', { name: '打开设置' }));

  const repository = screen.getByRole('link', { name: '打开 GitHub 项目' });
  expect(repository).toHaveAttribute('href', 'https://github.com/mrjoechen/PicTab');
  expect(repository).toHaveAttribute('target', '_blank');
  expect(repository).toHaveAttribute('rel', expect.stringContaining('noopener'));
  expect(repository).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
});
```

In the English-localization test, add:

```tsx
expect(screen.getByRole('link', { name: 'Open GitHub project' })).toBeInTheDocument();
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- src/newtab/settings/SettingsDrawer.test.tsx
```

Expected: FAIL because the settings header has no link named `打开 GitHub 项目`.

- [ ] **Step 3: Implement the minimal GitHub link**

Import the existing URL constant in `SettingsDrawer.tsx`:

```tsx
import { PROJECT_REPOSITORY_URL } from '../../project';
```

Add a localized label:

```tsx
repository: language === 'zh-CN' ? '打开 GitHub 项目' : 'Open GitHub project',
```

Insert this anchor before the language and close controls in `.drawer-header__actions`:

```tsx
<a className="github-link icon-button" href={PROJECT_REPOSITORY_URL} target="_blank" rel="noopener noreferrer" aria-label={labels.repository} title={labels.repository}><Icon name="github" /></a>
```

Add `github` to `IconName` and `iconPath` in `Icon.tsx`:

```tsx
case 'github': return <><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 19.4 4 5 5 0 0 0 19.3.5S18.2.1 15 1.8a13.4 13.4 0 0 0-7 0C4.8.1 3.7.5 3.7.5A5 5 0 0 0 3.6 4a5.4 5.4 0 0 0-1.4 3.7c0 5.4 3.5 6.6 6.8 7A4.8 4.8 0 0 0 8 18v4" /><path d="M8 19c-3 .9-3-1.5-4-2" /></>;
```

Add link styling beside `.language-toggle` in `styles.css`:

```css
.github-link {
  border: 0;
  border-radius: 10px;
  color: rgb(237 241 239 / 0.82);
  background: transparent;
  text-decoration: none;
  transition: color 180ms ease, background 180ms ease;
}

.github-link:hover {
  color: #fff;
  background: rgb(255 255 255 / 0.06);
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npm test -- src/newtab/settings/SettingsDrawer.test.tsx
```

Expected: all `SettingsDrawer` tests PASS.

### Task 3: Create equal-size README preview assets

**Files:**
- Create: `docs/assets/pictab-new-tab-preview.jpg`
- Create: `docs/assets/pictab-settings-preview.jpg`

- [ ] **Step 1: Center-crop the new-tab screenshot**

Run:

```bash
sips --cropToHeightWidth 880 1650 --setProperty format jpeg /Users/eeo/Downloads/Xnip2026-08-11_17-01-28.jpg --out docs/assets/pictab-new-tab-preview.jpg
```

Expected: `docs/assets/pictab-new-tab-preview.jpg` is created at `1650×880` without modifying the source image.

- [ ] **Step 2: Resize the new-tab screenshot**

Run:

```bash
sips --resampleHeightWidth 640 1200 --setProperty formatOptions 85 docs/assets/pictab-new-tab-preview.jpg
```

Expected: `docs/assets/pictab-new-tab-preview.jpg` is rewritten at exactly `1200×640`.

- [ ] **Step 3: Center-crop the settings screenshot**

Run:

```bash
sips --cropToHeightWidth 888 1665 --setProperty format jpeg /Users/eeo/Downloads/Xnip2026-08-11_17-01-47.jpg --out docs/assets/pictab-settings-preview.jpg
```

Expected: `docs/assets/pictab-settings-preview.jpg` is created at `1665×888` without modifying the source image.

- [ ] **Step 4: Resize the settings screenshot**

Run:

```bash
sips --resampleHeightWidth 640 1200 --setProperty formatOptions 85 docs/assets/pictab-settings-preview.jpg
```

Expected: `docs/assets/pictab-settings-preview.jpg` is rewritten at exactly `1200×640`.

- [ ] **Step 5: Verify asset formats and dimensions**

Run:

```bash
sips -g pixelWidth -g pixelHeight -g format docs/assets/pictab-new-tab-preview.jpg docs/assets/pictab-settings-preview.jpg
```

Expected: both files report `pixelWidth: 1200`, `pixelHeight: 640`, and `format: jpeg`.

### Task 4: Add bilingual README preview and support sections

**Files:**
- Modify: `README.md`
- Modify: `README_ZH.md`

- [ ] **Step 1: Add the English support and preview content**

After the license blockquote in `README.md`, insert:

```markdown
[☕ Support PicTab on Ko-fi](https://ko-fi.com/joechen)

## Preview

| New tab | Settings |
| --- | --- |
| ![PicTab new tab with clock, weather, and search](docs/assets/pictab-new-tab-preview.jpg) | ![PicTab settings with image-source controls](docs/assets/pictab-settings-preview.jpg) |
```

- [ ] **Step 2: Add the Chinese support and preview content**

After the license blockquote in `README_ZH.md`, insert:

```markdown
[☕ 在 Ko-fi 上支持 PicTab](https://ko-fi.com/joechen)

## 预览

| 新标签页 | 配置页面 |
| --- | --- |
| ![显示时间、天气与搜索的 PicTab 新标签页](docs/assets/pictab-new-tab-preview.jpg) | ![显示图片源管理的 PicTab 配置页面](docs/assets/pictab-settings-preview.jpg) |
```

- [ ] **Step 3: Verify both README references**

Run:

```bash
rg -n "ko-fi\.com/joechen|pictab-new-tab-preview\.jpg|pictab-settings-preview\.jpg" README.md README_ZH.md
```

Expected: each README contains one Ko-fi URL and references both preview assets.

### Task 5: Complete regression verification without committing

**Files:**
- Verify all files from Tasks 1–4

- [ ] **Step 1: Run focused component tests**

Run:

```bash
npm test -- src/newtab/settings/AboutPanel.test.tsx src/newtab/settings/SettingsDrawer.test.tsx
```

Expected: both test files PASS with zero failures.

- [ ] **Step 2: Run the complete project check**

Run:

```bash
npm run check
```

Expected: type checking, all Vitest tests, and the production build complete with exit code 0.

- [ ] **Step 3: Check whitespace and exact delivery scope**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` exits 0; this feature's source, test, style, README, plan, and two image files remain uncommitted alongside the user's pre-existing unrelated changes.

### Task 6: Replace the interim coffee SVG with the bundled Ko-fi logomark using TDD

**Files:**
- Create: `public/assets/ko-fi-logomark.webp`
- Modify: `src/newtab/settings/AboutPanel.test.tsx`
- Modify: `src/newtab/settings/AboutPanel.tsx`
- Modify: `src/newtab/components/Icon.tsx`
- Modify: `src/newtab/styles.css`

- [ ] **Step 1: Extend the existing support-link test with a failing asset assertion**

Add these assertions after the existing `rel` checks in `it('offers a safe Ko-fi support link', ...)`:

```tsx
const logo = support.querySelector('img');
expect(logo).toHaveAttribute('src', '/assets/ko-fi-logomark.webp');
expect(logo).toHaveAttribute('alt', '');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- src/newtab/settings/AboutPanel.test.tsx
```

Expected: FAIL because the current support link contains the interim coffee SVG and no `img` element.

- [ ] **Step 3: Copy and verify the supplied WebP without transforming it**

Run:

```bash
cp /Users/eeo/Downloads/logomarkLogo2024.webp public/assets/ko-fi-logomark.webp
sips -g pixelWidth -g pixelHeight -g format -g hasAlpha public/assets/ko-fi-logomark.webp
```

Expected: the project asset reports `161×130`, `format: webp`, and `hasAlpha: yes`.

- [ ] **Step 4: Render the local Ko-fi image and remove the interim SVG icon**

Replace the current coffee `Icon` in the About link with:

```tsx
<img className="about-link__logo" src={runtimeAssetUrl('assets/ko-fi-logomark.webp')} alt="" />
```

Remove `'coffee'` from `IconName` and remove its `iconPath` case from `Icon.tsx`.

Add the focused asset rule in `styles.css`:

```css
.about-link__logo { display: block; width: auto; height: 18px; }
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
npm test -- src/newtab/settings/AboutPanel.test.tsx
```

Expected: all `AboutPanel` tests PASS.

### Task 7: Replace both README support links with the corrected Ko-fi badge

**Files:**
- Modify: `README.md`
- Modify: `README_ZH.md`

- [ ] **Step 1: Replace the English support link**

Replace `[☕ Support PicTab on Ko-fi](https://ko-fi.com/joechen)` with:

```html
<a href="https://ko-fi.com/joechen"><img src="https://img.shields.io/badge/ko--fi-Buy_me_a_coffee-ff5f5f?logo=ko-fi&style=for-the-badge" alt="ko-fi"></a>
```

- [ ] **Step 2: Replace the Chinese support link**

Replace `[☕ 在 Ko-fi 上支持 PicTab](https://ko-fi.com/joechen)` with the same HTML:

```html
<a href="https://ko-fi.com/joechen"><img src="https://img.shields.io/badge/ko--fi-Buy_me_a_coffee-ff5f5f?logo=ko-fi&style=for-the-badge" alt="ko-fi"></a>
```

- [ ] **Step 3: Verify the corrected badge and reject the malformed style**

Run:

```bash
rg -n "img\.shields\.io/badge/ko--fi-Buy_me_a_coffee-ff5f5f\?logo=ko-fi&style=for-the-badge" README.md README_ZH.md
rg -n "for-the-badgeKo-fi" README.md README_ZH.md
```

Expected: the first command finds one badge in each README; the second command finds no matches.

### Task 8: Verify the branded donation refinement without committing

**Files:**
- Verify all files from Tasks 6–7

- [ ] **Step 1: Run the focused About-panel test**

Run:

```bash
npm test -- src/newtab/settings/AboutPanel.test.tsx
```

Expected: all `AboutPanel` tests PASS.

- [ ] **Step 2: Run the complete project check**

Run:

```bash
npm run check
```

Expected: type checking, all Vitest tests, and the production build complete with exit code 0.

- [ ] **Step 3: Audit assets, whitespace, and uncommitted delivery**

Run:

```bash
sips -g pixelWidth -g pixelHeight -g format -g hasAlpha public/assets/ko-fi-logomark.webp
git diff --check
git status --short
```

Expected: the Ko-fi asset remains a `161×130` transparent WebP, `git diff --check` exits 0, and all implementation changes remain uncommitted.

### Task 9: Add the settings-header donation shortcut with TDD

**Files:**
- Modify: `src/project.ts`
- Modify: `src/newtab/settings/AboutPanel.tsx`
- Modify: `src/newtab/settings/SettingsDrawer.test.tsx`
- Modify: `src/newtab/settings/SettingsDrawer.tsx`
- Modify: `src/newtab/styles.css`

- [ ] **Step 1: Write the failing settings-header donation test**

Add a test that opens the drawer and asserts the `支持作者` link uses `https://ko-fi.com/joechen`, `target="_blank"`, both `noopener` and `noreferrer`, and a decorative image at `/assets/ko-fi-logomark.webp`. Extend the English-localization test to assert the accessible name `Support the author`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- src/newtab/settings/SettingsDrawer.test.tsx
```

Expected: FAIL because the settings header has no link named `支持作者`.

- [ ] **Step 3: Implement the shared donation destination and header link**

Export `PROJECT_DONATION_URL` from `src/project.ts`, consume it from both settings components, and remove the About panel's duplicate local constant. Add a localized `donation` label to `SettingsDrawer` and render a secure external link with the bundled Ko-fi image after the GitHub anchor in DOM order.

Style the donation control as a 44-pixel icon button, render the logo at 20 pixels high with automatic width, and set the visual action sequence to Ko-fi, GitHub, language, close through CSS `order` values. Keep close first in DOM order so the existing focus-trap behavior does not change.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npm test -- src/newtab/settings/SettingsDrawer.test.tsx
```

Expected: all `SettingsDrawer` tests PASS, including focus management and both localizations.

### Task 10: Build and verify the complete uncommitted result

**Files:**
- Verify all feature files and generated `dist` output

- [ ] **Step 1: Run focused settings tests**

Run:

```bash
npm test -- src/newtab/settings/AboutPanel.test.tsx src/newtab/settings/SettingsDrawer.test.tsx
```

Expected: both test files PASS with zero failures.

- [ ] **Step 2: Run the complete project check and production build**

Run:

```bash
npm run check
```

Expected: type checking, the full Vitest suite, and the production build to `dist` complete successfully.

- [ ] **Step 3: Audit the built asset and uncommitted delivery**

Run:

```bash
test -f dist/assets/ko-fi-logomark.webp
cmp public/assets/ko-fi-logomark.webp dist/assets/ko-fi-logomark.webp
git diff --check
git status --short
```

Expected: the bundled Ko-fi image exists unchanged in `dist`, whitespace validation passes, and implementation changes remain uncommitted for user testing.
