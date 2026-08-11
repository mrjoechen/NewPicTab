# Donation and GitHub Links Design

## Goal

Make it easy for PicTab users to support the author and reach the public source repository from the settings experience and project documentation.

## Scope

- Add a Ko-fi donation link to the About panel's “Source and license” link row.
- Add a GitHub repository icon link to the settings drawer header.
- Add a Ko-fi support link to both `README.md` and `README_ZH.md`.
- Add matching line icons to the existing shared `Icon` component.

No donation processing, embedded Ko-fi content, analytics, or new browser permissions are introduced.

## Interface Design

### About panel

Add a compact icon-and-text link labeled “支持作者” in Chinese and “Support the author” in English. It sits beside the existing license and source-repository links and uses the shared coffee icon. The destination is `https://ko-fi.com/joechen`.

### Settings drawer

Add an icon-only GitHub repository link to the header action group, alongside the close and language controls. It uses the shared GitHub icon and receives localized `aria-label` and `title` text: “打开 GitHub 项目” in Chinese and “Open GitHub project” in English. The destination is the existing `PROJECT_REPOSITORY_URL` constant.

### README files

Add a short support link near the introductory project links in each README. The English text uses “Support PicTab on Ko-fi”; the Chinese text uses “在 Ko-fi 上支持 PicTab”. The link points to the same Ko-fi URL as the About panel.

## Security and Accessibility

- Browser UI links open in a new tab with `target="_blank"` and `rel="noopener noreferrer"`.
- Add `ko-fi.com` to the About panel's explicit HTTPS external-host allowlist.
- Icon-only links have localized accessible names and tooltips.
- Decorative SVGs remain hidden from assistive technology; the link text or accessible name supplies meaning.
- Existing 44-pixel link/control hit-area conventions remain in effect.

## Implementation Boundaries

- Extend `IconName` and `iconPath` with `coffee` and `github`; do not add image assets or third-party packages.
- Reuse `PROJECT_REPOSITORY_URL` for the settings header link to avoid duplicating the repository address.
- Keep the Ko-fi URL as a single About-panel constant and mirror the same stable URL in Markdown documentation.
- Limit styling changes to the new icon-and-text About link and settings-header anchor behavior, preserving existing controls and unrelated user edits in `styles.css`.

## Testing

- Update `AboutPanel.test.tsx` first and confirm it fails because the support link is absent; assert the accessible label, exact Ko-fi URL, new-tab target, and safe relation.
- Update `SettingsDrawer.test.tsx` first and confirm it fails because the GitHub header link is absent; assert its accessible name, repository URL, new-tab target, and safe relation.
- Implement only enough component, icon, localization, and style changes to make the tests pass.
- Run the focused tests, then the full test suite and production build.
- Check both README files for the exact Ko-fi URL and language-appropriate labels.

