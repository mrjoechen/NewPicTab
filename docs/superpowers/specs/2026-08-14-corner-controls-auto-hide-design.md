# Corner Controls Auto-Hide Design

## Goal

Keep the resting new-tab page visually quiet by hiding the bottom-left image-change icon and bottom-right settings icon until the pointer reaches the corresponding corner.

## Requirements

- The left and right controls have independent `96 × 96px` activation regions anchored to their viewport corners.
- On fine-pointer devices, each icon is hidden at rest and only its own corner reveals it.
- Leaving a corner hides its icon with the existing `180ms` opacity/transform transition.
- Keyboard focus always reveals the focused control.
- Touch/coarse-pointer devices keep both controls visible because hover is unavailable.
- The buttons remain `36 × 36px`, retain their existing labels and actions, and stay `16px` from the safe-area-adjusted edges.
- `prefers-reduced-motion: reduce` removes the reveal transition.

## Considered Approaches

1. **Independent CSS hot zones (selected).** Wrap each button in a fixed corner region and use `:hover`/`:focus-within` plus pointer media queries. This keeps both corners isolated without runtime mouse tracking.
2. **React pointer-position tracking.** A global `pointermove` listener could calculate proximity precisely, but it adds global state and frequent event handling for behavior CSS already models.
3. **Global idle timer.** Hiding both controls after inactivity is common, but it conflicts with the requirement that entering one corner wakes only that corner.

## Structure and Styling

- Add a shared `corner-control` wrapper with left/right modifier classes around the existing buttons in `App` and `SettingsDrawer`.
- The wrapper owns fixed positioning and the `96 × 96px` hit region; the button is positioned inside it using the current safe-area offsets.
- Under `(hover: hover) and (pointer: fine)`, the button starts transparent, slightly translated downward, and non-interactive to the pointer. The wrapper's `:hover` and `:focus-within` states restore opacity, transform, and pointer interaction.
- Outside that media query, the existing visible-button behavior remains unchanged.

## Accessibility and Failure Behavior

- Hidden buttons remain in the tab order. Receiving keyboard focus activates `:focus-within`, so the icon becomes visible before interaction.
- ARIA labels and titles remain unchanged.
- No JavaScript or persisted state is involved, so there is no asynchronous or storage failure path.

## Testing

- Component tests verify that both controls are placed in distinct left/right corner wrappers and retain their accessible button labels.
- Styles tests verify the `96px` regions, fine-pointer hidden state, independent hover/focus reveal selectors, coarse-pointer-visible fallback, and reduced-motion override.
- Run the complete typecheck, unit-test, and production-build suite after implementation.

## Non-Goals

- No user-configurable hot-zone size or hide delay.
- No global cursor tracking or inactivity timer.
- No changes to the settings drawer or image rotation actions themselves.
