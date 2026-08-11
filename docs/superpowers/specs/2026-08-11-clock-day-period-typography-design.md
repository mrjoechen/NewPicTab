# Clock Day-Period Typography Design

## Goal

When PicTab uses a 12-hour clock, render the localized day-period label (`上午`、`下午`、`AM`、`PM`) at 45% of the numeric time size with a 0.3em gap from the numeric time. Vertically center the label against the numeric time, keep the locale-defined order, and keep the complete clock on one line at responsive viewport sizes.

## Considered approaches

1. Parse the formatted string with regular expressions. This is small, but it is fragile across locales and punctuation variants.
2. Use `Intl.DateTimeFormat.formatToParts()` and render `dayPeriod` separately. This preserves locale semantics and gives the label a stable styling hook. This is the selected approach.
3. Infer the label with CSS-only selectors. The current DOM does not expose the day period separately, so this cannot reliably meet the requirement.

## Component design

`ClockWeather` will format time with `Intl.DateTimeFormat.formatToParts()`. It will render numeric and separator parts inside one inline-flex time-value group, and render the `dayPeriod` part as a sibling. The day-period sibling appears before the value for locales such as `zh-CN` and after it for locales such as `en-US`.

Whitespace-only formatter literals next to the day period will not be rendered. The parent clock uses a 0.3em flex gap, measured against the main time size, so spacing is consistent regardless of the smaller label size. The full localized formatter output remains available as the time element's accessible label.

## Visual rules

- Numeric time retains its current font size, tracking, baseline, and responsive limits.
- Day-period text uses `font-size: 0.45em` and `align-self: center` so its box is vertically centered against the numeric time while the numeric pieces retain their baseline alignment.
- The day period and numeric time use `gap: 0.3em`.
- The entire clock remains `white-space: nowrap`.

## Testing

- Component tests verify that `PM` is a separate trailing day-period element in `en-US`, while `下午` is a separate leading element in `zh-CN`.
- CSS guardrail tests verify the 45% font size and 0.3em gap.
- Existing responsive end-to-end coverage continues to verify every 12/24-hour and seconds/no-seconds combination remains within the viewport. Its bounds measurement covers the entire clock, and 12-hour cases verify the day-period and numeric-time centers differ by no more than one pixel.
