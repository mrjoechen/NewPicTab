# Clock Day-Period Typography Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render localized 12-hour day-period labels at 45% of the time size with a 0.3em gap, vertically centered against the numeric time, while preserving locale order and responsive containment.

**Architecture:** Replace string splitting with `Intl.DateTimeFormat.formatToParts()` so `dayPeriod` can be rendered as a sibling of one grouped numeric time value. Apply the gap on the full-size clock flex container, the scale and cross-axis centering on the day-period element, then extend unit and end-to-end guardrails.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Testing Library, Playwright

---

### Task 1: Describe the day-period DOM and typography

**Files:**
- Modify: `src/newtab/components/ClockWeather.test.tsx`
- Modify: `src/newtab/styles.test.ts`

- [ ] **Step 1: Write the failing component test**

Add a focused test that fixes the clock at an afternoon time, selects 12-hour mode, and verifies that `en-US` renders a `.clock-weather__day-period` containing `PM` after `.clock-weather__time-value`. Rerender with `zh-CN` and verify `下午` appears before the value.

```tsx
it('renders the localized 12-hour day period separately in locale order', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-04T13:05:06'));
  const value = widgets(); value.clock.hour12 = true; value.date.enabled = false;
  const view = render(<ClockWeather settings={value} locale="en-US" />);
  const englishClock = screen.getByTestId('clock');
  expect(englishClock.querySelector('.clock-weather__day-period')).toHaveTextContent('PM');
  expect(englishClock.lastElementChild).toHaveClass('clock-weather__day-period');

  view.rerender(<ClockWeather settings={value} locale="zh-CN" />);
  const chineseClock = screen.getByTestId('clock');
  expect(chineseClock.querySelector('.clock-weather__day-period')).toHaveTextContent('下午');
  expect(chineseClock.firstElementChild).toHaveClass('clock-weather__day-period');
});
```

- [ ] **Step 2: Write the failing CSS guardrail**

Add assertions that the time container has a 0.3em gap and the dedicated day-period selector has a 0.45em font size with independent vertical centering.

```ts
expect(css).toMatch(/\.clock-weather__time\s*\{[^}]*gap:\s*0\.3em;/s);
expect(css).toMatch(/\.clock-weather__day-period\s*\{[^}]*align-self:\s*center;[^}]*font-size:\s*0\.45em;/s);
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `npm test -- src/newtab/components/ClockWeather.test.tsx src/newtab/styles.test.ts`

Expected for the alignment correction: FAIL because `.clock-weather__day-period` does not yet declare `align-self: center`.

### Task 2: Render and style the localized day period

**Files:**
- Modify: `src/newtab/components/ClockWeather.tsx`
- Modify: `src/newtab/styles.css`

- [ ] **Step 1: Format time into semantic parts**

Replace the memoized formatted string with parts and add a safe fallback for invalid locales.

```tsx
const time = useMemo(() => safeFormatToParts(now, locale, {
  hour: 'numeric', minute: '2-digit', ...(settings.clock.showSeconds ? { second: '2-digit' } : {}), hour12: settings.clock.hour12
}), [locale, now, settings.clock.hour12, settings.clock.showSeconds]);

function safeFormatToParts(value: Date, locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormatPart[] {
  try { return new Intl.DateTimeFormat(locale || undefined, options).formatToParts(value); }
  catch { return new Intl.DateTimeFormat(undefined, options).formatToParts(value); }
}
```

Set `aria-label` to `time.map((part) => part.value).join('')` and pass the parts to `renderTimeParts`.

- [ ] **Step 2: Render day period and numeric time as siblings**

Replace the string splitter with a renderer that drops whitespace-only literals, groups non-day-period parts, and preserves whether `dayPeriod` is leading or trailing.

```tsx
function renderTimeParts(parts: Intl.DateTimeFormatPart[]) {
  const visibleParts = parts.filter((part) => part.type !== 'literal' || part.value.trim());
  const dayPeriodIndex = visibleParts.findIndex((part) => part.type === 'dayPeriod');
  const dayPeriod = visibleParts[dayPeriodIndex];
  const value = <span className="clock-weather__time-value">{visibleParts
    .filter((part) => part.type !== 'dayPeriod')
    .map((part, index) => {
      const separator = part.type === 'literal' && (part.value === ':' || part.value === '：');
      return <span key={`${part.type}-${part.value}-${index}`} className={separator ? 'clock-weather__time-separator' : 'clock-weather__time-number'}>{part.value}</span>;
    })}</span>;
  if (!dayPeriod) return value;
  const label = <span className="clock-weather__day-period">{dayPeriod.value}</span>;
  return dayPeriodIndex === 0 ? <>{label}{value}</> : <>{value}{label}</>;
}
```

- [ ] **Step 3: Add typography rules**

Add `gap: 0.3em` to `.clock-weather__time`, keep the numeric pieces in a baseline-aligned inline flex group, and scale the label.

```css
.clock-weather__time {
  gap: 0.3em;
}

.clock-weather__time-value {
  display: inline-flex;
  align-items: baseline;
}

.clock-weather__day-period {
  align-self: center;
  font-size: 0.45em;
  line-height: 1;
  letter-spacing: 0.02em;
}
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npm test -- src/newtab/components/ClockWeather.test.tsx src/newtab/styles.test.ts`

Expected: both test files PASS with no warnings.

### Task 3: Cover full responsive bounds and vertical alignment

**Files:**
- Modify: `e2e/clock-layout.spec.ts`

- [ ] **Step 1: Measure the full clock bounds and child centers**

Keep numeric character rectangles for wrap detection, use the time element's bounding rectangle for left and right containment so the day period is included, and measure the day-period center against the numeric group center.

```ts
const clockRect = element.getBoundingClientRect();
const valueRect = element.querySelector('.clock-weather__time-value')?.getBoundingClientRect();
const dayPeriodRect = element.querySelector('.clock-weather__day-period')?.getBoundingClientRect();
return {
  topSpread: Math.max(...rects.map((rect) => rect.top)) - Math.min(...rects.map((rect) => rect.top)),
  left: clockRect.left,
  right: clockRect.right,
  viewportWidth: window.innerWidth,
  centerDelta: valueRect && dayPeriodRect
    ? Math.abs((valueRect.top + valueRect.bottom - dayPeriodRect.top - dayPeriodRect.bottom) / 2)
    : null
};
```

For 12-hour cases, assert `centerDelta` is at most one pixel.

```ts
if (format.hour12) expect(metrics.centerDelta, `${caseName}: day period was not vertically centered`).toBeLessThanOrEqual(1);
```

- [ ] **Step 2: Run all deterministic checks**

Run: `npm run check`

Expected: TypeScript, Vitest, and production build all PASS.

- [ ] **Step 3: Run the responsive clock end-to-end test when Chromium is available**

Run: `npm run build && npx playwright test e2e/clock-layout.spec.ts`

Expected: PASS for 12-hour and 24-hour clocks, with and without seconds, at every covered viewport.
