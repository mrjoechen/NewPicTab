# Corner Controls Auto-Hide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the bottom-left image-change icon and bottom-right settings icon on fine-pointer devices until the pointer enters the corresponding `96 × 96px` corner region, while preserving touch and keyboard access.

**Architecture:** Wrap each existing button in an independent fixed corner region and implement reveal behavior entirely in CSS. Fine-pointer media queries hide/reveal icons with `:hover` and `:focus-within`; coarse-pointer defaults keep icons visible without JavaScript state.

**Tech Stack:** React 19, TypeScript, CSS media queries, Vitest, Testing Library

---

### Task 1: Add independent corner-control regions

**Files:**
- Modify: `src/newtab/App.test.tsx`
- Modify: `src/newtab/App.tsx:337`
- Modify: `src/newtab/settings/SettingsDrawer.tsx:99-101`

- [ ] **Step 1: Write the failing structural test**

Add this test inside the `App` describe block in `src/newtab/App.test.tsx`:

```tsx
it('places image change and settings in independent corner reveal regions', () => {
  render(<App />);

  expect(screen.getByRole('button', { name: '切换图片' }).closest('.corner-control'))
    .toHaveClass('corner-control--left');
  expect(screen.getByRole('button', { name: '打开设置' }).closest('.corner-control'))
    .toHaveClass('corner-control--right');
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
npm test -- src/newtab/App.test.tsx -t "places image change and settings in independent corner reveal regions"
```

Expected: FAIL because each button's closest `.corner-control` is `null`.

- [ ] **Step 3: Wrap the image-change button**

Replace the standalone button in `src/newtab/App.tsx` with:

```tsx
<div className="corner-control corner-control--left">
  <button className="change-image-trigger corner-control__button icon-button" type="button" aria-label={settings.interfaceLanguage === 'zh-CN' ? '切换图片' : 'Change image'} title={settings.interfaceLanguage === 'zh-CN' ? '切换图片' : 'Change image'} onClick={() => void background.goNext()}><Icon name="refresh" /></button>
</div>
```

- [ ] **Step 4: Wrap the settings trigger**

Replace the standalone trigger in `src/newtab/settings/SettingsDrawer.tsx` with:

```tsx
<div className="corner-control corner-control--right">
  <button ref={triggerRef} className="settings-trigger corner-control__button icon-button" type="button" aria-label={labels.open} title={labels.open} onClick={() => { onOpen(); setOpen(true); }}><Icon name="settings" /></button>
</div>
```

- [ ] **Step 5: Run the structural test to verify GREEN**

Run:

```bash
npm test -- src/newtab/App.test.tsx -t "places image change and settings in independent corner reveal regions"
```

Expected: PASS.

- [ ] **Step 6: Commit the structural change**

```bash
git add src/newtab/App.tsx src/newtab/App.test.tsx src/newtab/settings/SettingsDrawer.tsx
git commit -m "feat: add corner reveal regions"
```

### Task 2: Implement fine-pointer reveal and accessible fallbacks

**Files:**
- Modify: `src/newtab/styles.test.ts`
- Modify: `src/newtab/styles.css:642-699`
- Modify: `src/newtab/styles.css:2089-2118`

- [ ] **Step 1: Write the failing CSS guardrail test**

Add this describe block to `src/newtab/styles.test.ts`:

```ts
describe('corner control reveal guardrails', () => {
  it('reveals each 96px corner control for fine pointers and preserves touch and focus access', () => {
    const css = readFileSync('src/newtab/styles.css', 'utf8');
    expect(css).toMatch(/\.corner-control\s*\{[^}]*position:\s*fixed;[^}]*width:\s*96px;[^}]*height:\s*96px;/s);
    expect(css).toMatch(/\.corner-control--left\s*\{[^}]*left:\s*0;/s);
    expect(css).toMatch(/\.corner-control--right\s*\{[^}]*right:\s*0;/s);
    expect(css).toMatch(/@media \(hover:\s*hover\) and \(pointer:\s*fine\)[\s\S]*\.corner-control__button\s*\{[^}]*opacity:\s*0;[^}]*translate:\s*0 6px;[^}]*pointer-events:\s*none;/s);
    expect(css).toMatch(/\.corner-control:where\(:hover,\s*:focus-within\) \.corner-control__button\s*\{[^}]*opacity:\s*1;[^}]*translate:\s*0 0;[^}]*pointer-events:\s*auto;/s);
    expect(css).toMatch(/@media \(hover:\s*none\),\s*\(pointer:\s*coarse\)[\s\S]*\.corner-control__button\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s);
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.corner-control__button/);
  });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
npm test -- src/newtab/styles.test.ts -t "reveals each 96px corner control"
```

Expected: FAIL because `.corner-control` styles and pointer media queries do not exist.

- [ ] **Step 3: Add the corner regions and move positioning to their buttons**

Add before `.settings-trigger` in `src/newtab/styles.css` and change the button positioning from fixed to absolute:

```css
.corner-control {
  position: fixed;
  z-index: 8;
  bottom: 0;
  width: 96px;
  height: 96px;
}

.corner-control--left { left: 0; }
.corner-control--right { right: 0; }

.corner-control__button {
  position: absolute;
  opacity: 1;
  translate: 0 0;
  pointer-events: auto;
  transition: color 180ms ease, opacity 180ms ease, transform 180ms ease, translate 180ms ease;
}

.settings-trigger {
  right: max(16px, env(safe-area-inset-right));
  bottom: max(16px, env(safe-area-inset-bottom));
}

.change-image-trigger {
  left: max(16px, env(safe-area-inset-left));
  bottom: max(16px, env(safe-area-inset-bottom));
}
```

Keep the existing size, color, background, cursor, text-shadow, border, and hover declarations on `.settings-trigger` and `.change-image-trigger`, removing only their old `position`, `z-index`, and duplicate `transition` declarations.

- [ ] **Step 4: Add fine-pointer hide/reveal and coarse-pointer fallback**

Add after both button hover rules:

```css
@media (hover: hover) and (pointer: fine) {
  .corner-control__button {
    opacity: 0;
    translate: 0 6px;
    pointer-events: none;
  }

  .corner-control:where(:hover, :focus-within) .corner-control__button {
    opacity: 1;
    translate: 0 0;
    pointer-events: auto;
  }
}

@media (hover: none), (pointer: coarse) {
  .corner-control__button {
    opacity: 1;
    translate: 0 0;
    pointer-events: auto;
  }
}
```

- [ ] **Step 5: Respect reduced motion**

Add `.corner-control__button` to the existing `prefers-reduced-motion: reduce` selector list and add `translate: 0 0 !important;` to that rule so reveal/hide has no movement or transition.

- [ ] **Step 6: Run style and component tests to verify GREEN**

Run:

```bash
npm test -- src/newtab/styles.test.ts src/newtab/App.test.tsx
```

Expected: both test files PASS with no warnings.

- [ ] **Step 7: Commit the reveal behavior**

```bash
git add src/newtab/styles.css src/newtab/styles.test.ts
git commit -m "feat: auto-hide corner controls"
```

### Task 3: Verify the complete feature

**Files:**
- Verify: `src/newtab/App.tsx`
- Verify: `src/newtab/settings/SettingsDrawer.tsx`
- Verify: `src/newtab/styles.css`
- Verify: `src/newtab/App.test.tsx`
- Verify: `src/newtab/styles.test.ts`

- [ ] **Step 1: Run the complete project check**

Run:

```bash
npm run check
```

Expected: TypeScript passes, all Vitest tests pass, and the Vite production build succeeds.

- [ ] **Step 2: Check patch hygiene and scope**

Run:

```bash
git diff --check HEAD
git status --short
```

Expected: no whitespace errors; only the pre-existing `SourceEditor` work and any intentionally uncommitted plan file remain.

- [ ] **Step 3: Manually verify interaction in Chrome**

Confirm on a fine-pointer device that both icons are hidden at rest, moving into the left corner reveals only image change, moving into the right corner reveals only settings, and leaving hides the icon. Confirm keyboard Tab reveals the focused icon and Chrome touch emulation keeps both visible.

- [ ] **Step 4: Save the implementation plan**

```bash
git add docs/superpowers/plans/2026-08-14-corner-controls-auto-hide.md
git commit -m "docs: add corner control implementation plan"
```
