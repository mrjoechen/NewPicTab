# Donation, GitHub, and README Preview Design

## Goal

Make it easy for PicTab users to see the extension, support the author, and reach the public source repository from the settings experience and project documentation.

## Scope

- Add a branded Ko-fi donation link to the About panel's “Source and license” link row.
- Add a GitHub repository icon link to the settings drawer header.
- Add a Ko-fi badge and two extension preview images to both `README.md` and `README_ZH.md`.
- Add a GitHub line icon to the existing shared `Icon` component.

No donation processing, embedded Ko-fi content, analytics, or new browser permissions are introduced.

## Interface Design

### About panel

Add a compact icon-and-text link labeled “支持作者” in Chinese and “Support the author” in English. It sits beside the existing license and source-repository links and uses the supplied Ko-fi logomark from a bundled local WebP asset. The destination is `https://ko-fi.com/joechen`.

### Settings drawer

Add an icon-only GitHub repository link to the header action group, alongside the close and language controls. It uses the shared GitHub icon and receives localized `aria-label` and `title` text: “打开 GitHub 项目” in Chinese and “Open GitHub project” in English. The destination is the existing `PROJECT_REPOSITORY_URL` constant.

### README files

Add the same Ko-fi badge near the introductory project links in both README files. Use this HTML in each file:

```html
<a href="https://ko-fi.com/joechen"><img src="https://img.shields.io/badge/ko--fi-Buy_me_a_coffee-ff5f5f?logo=ko-fi&style=for-the-badge" alt="ko-fi"></a>
```

The corrected `style=for-the-badge` value follows Shields.io's supported static-badge style syntax. The badge links to the same Ko-fi URL as the About panel.

Add a “Preview” section to `README.md` and a “预览” section to `README_ZH.md` after the introductory license note and before the feature list. Each section uses a two-column Markdown table to display the new-tab and settings screenshots side by side at equal rendered size, with language-appropriate captions and alt text.

## Preview Image Processing

The two user-provided JPEG screenshots are edit targets:

- `/Users/eeo/Downloads/Xnip2026-08-11_17-01-28.jpg` is the new-tab preview.
- `/Users/eeo/Downloads/Xnip2026-08-11_17-01-47.jpg` is the settings preview.

Preserve all visible pixels, UI text, colors, and composition except for the minimum centered crop needed to normalize the aspect ratio. Do not use generative redraw, stretching, overlays, or added decoration.

- Center-crop the first image from `1662×888` to `1650×880`.
- Center-crop the second image from `1668×889` to `1665×888`.
- Resize both cropped images to exactly `1200×640` and encode them as JPEG at quality 85.
- Save them as `docs/assets/pictab-new-tab-preview.jpg` and `docs/assets/pictab-settings-preview.jpg`.
- Keep the source files in Downloads unchanged.

## Ko-fi Logo Asset

Treat `/Users/eeo/Downloads/logomarkLogo2024.webp` as the source for the About-panel donation icon. It is a `161×130` WebP with transparency and is approximately 2 KB.

- Copy it without resizing or re-encoding to `public/assets/ko-fi-logomark.webp`.
- Render it at an 18-pixel CSS height with automatic width so its original aspect ratio is preserved.
- Keep the source file in Downloads unchanged.
- Do not load the About-panel icon from Ko-fi or another remote host.

## Security and Accessibility

- Browser UI links open in a new tab with `target="_blank"` and `rel="noopener noreferrer"`.
- Add `ko-fi.com` to the About panel's explicit HTTPS external-host allowlist.
- Icon-only links have localized accessible names and tooltips.
- Decorative SVGs remain hidden from assistive technology; the link text or accessible name supplies meaning.
- Existing 44-pixel link/control hit-area conventions remain in effect.
- README preview images have descriptive, localized alt text and are stored in the repository rather than loaded from an external host.
- The About-panel Ko-fi image is decorative (`alt=""`) because the adjacent localized link text supplies its accessible name.

## Implementation Boundaries

- Extend `IconName` and `iconPath` with `github`; remove the interim `coffee` icon after the Ko-fi logomark replaces it.
- Reuse `PROJECT_REPOSITORY_URL` for the settings header link to avoid duplicating the repository address.
- Keep the Ko-fi URL as a single About-panel constant and mirror the same stable URL in Markdown documentation.
- Limit styling changes to the Ko-fi icon-and-text About link and settings-header anchor behavior, preserving existing controls and unrelated user edits in `styles.css`.
- Treat the resized preview images as documentation assets; do not add them to the extension bundle or runtime manifest.

## Testing

- Update `AboutPanel.test.tsx` first and confirm it fails because the bundled Ko-fi logomark is absent; retain assertions for the accessible label, exact Ko-fi URL, new-tab target, and safe relation, and assert the image source and empty alt text.
- Update `SettingsDrawer.test.tsx` first and confirm it fails because the GitHub header link is absent; assert its accessible name, repository URL, new-tab target, and safe relation.
- Implement only enough component, icon, localization, and style changes to make the tests pass.
- Run the focused tests, then the full test suite and production build.
- Check both README files for the exact corrected Ko-fi badge HTML.
- Verify both saved preview assets are JPEG files with exact `1200×640` dimensions and that both README files reference both assets.
- Verify `public/assets/ko-fi-logomark.webp` remains a `161×130` WebP with an alpha channel.

## Delivery

Leave implementation code, README, and image-asset changes uncommitted in the working tree, as requested. The design document may be committed separately before implementation.
