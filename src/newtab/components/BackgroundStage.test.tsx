import { readFileSync } from 'node:fs';

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundStage } from './BackgroundStage';

const current = { id: 'current', sourceId: 'source', url: 'https://images.test/current.jpg' };
const previous = { id: 'previous', sourceId: 'source', url: 'https://images.test/previous.jpg' };

type MediaListener = (event: MediaQueryListEvent) => void;
let mediaListener: MediaListener | undefined;

function mockReducedMotion(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: (_type: string, listener: MediaListener) => { mediaListener = listener; },
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  });
}

afterEach(() => {
  cleanup();
  mediaListener = undefined;
  vi.restoreAllMocks();
});

describe('BackgroundStage', () => {
  it('renders stable previous and current image layers with directional motion metadata', () => {
    mockReducedMotion(false);
    render(
      <BackgroundStage
        current={current}
        previous={previous}
        transition="slide"
        transitionMs={850}
        direction="previous"
      />
    );

    const stage = screen.getByTestId('background-stage');
    expect(stage).toHaveAttribute('data-transition', 'slide');
    expect(stage).toHaveAttribute('data-direction', 'previous');
    expect(stage.style.getPropertyValue('--background-transition-ms')).toBe('850ms');
    expect(screen.getByTestId('background-previous')).toHaveStyle({
      backgroundImage: 'url("https://images.test/previous.jpg")'
    });
    expect(screen.getByTestId('background-previous')).toHaveAttribute('data-source-id', 'source');
    expect(screen.getByTestId('background-previous')).toHaveAttribute('data-image-id', 'previous');
    expect(screen.getByTestId('background-current')).toHaveStyle({
      backgroundImage: 'url("https://images.test/current.jpg")'
    });
    expect(screen.getByTestId('background-current').tagName).toBe('IMG');
    expect(screen.getByTestId('background-current')).toHaveAttribute('src', current.url);
    expect(screen.getByTestId('background-current')).toHaveAttribute('data-source-id', 'source');
    expect(screen.getByTestId('background-current')).toHaveAttribute('data-image-id', 'current');
  });

  it('keeps both layers mounted when either image is absent', () => {
    mockReducedMotion(false);
    render(<BackgroundStage current={null} previous={null} transition="fade" transitionMs={400} />);

    expect(screen.getByTestId('background-previous')).toBeInTheDocument();
    expect(screen.getByTestId('background-current')).toBeInTheDocument();
  });

  it('preserves both physical layer nodes when the images change', () => {
    mockReducedMotion(false);
    const reflows = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
    const { rerender } = render(
      <BackgroundStage current={current} previous={previous} transition="fade" transitionMs={400} />
    );
    const currentLayer = screen.getByTestId('background-current');
    const previousLayer = screen.getByTestId('background-previous');

    rerender(
      <BackgroundStage current={previous} previous={current} transition="fade" transitionMs={400} />
    );

    expect(screen.getByTestId('background-current')).toBe(currentLayer);
    expect(screen.getByTestId('background-previous')).toBe(previousLayer);
    expect(reflows).toHaveBeenCalledTimes(1);
  });

  it('does not replay the transition when the same image receives a fresher URL', () => {
    mockReducedMotion(false);
    const reflows = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
    const { rerender } = render(
      <BackgroundStage current={{ ...current, url: 'blob:cached-current' }} previous={previous} transition="fade" transitionMs={400} />
    );

    rerender(
      <BackgroundStage current={{ ...current, url: 'blob:fresh-current' }} previous={previous} transition="fade" transitionMs={400} />
    );

    expect(screen.getByTestId('background-current')).toHaveAttribute('src', 'blob:fresh-current');
    expect(reflows).not.toHaveBeenCalled();
  });

  it('separates the Ken Burns display motion from its cross-fade duration', () => {
    mockReducedMotion(false);
    render(
      <BackgroundStage
        current={current}
        previous={previous}
        transition="ken-burns"
        transitionMs={900}
        kenBurnsMs={36_000}
      />
    );

    const stage = screen.getByTestId('background-stage');
    expect(stage.style.getPropertyValue('--background-transition-ms')).toBe('900ms');
    expect(stage.style.getPropertyValue('--background-display-ms')).toBe('36000ms');
    expect(stage).toHaveAttribute('data-display-motion', 'ken-burns');
  });

  it('combines a short opacity cross-fade with a separate slow pan and scale animation', () => {
    const css = readFileSync('src/newtab/styles.css', 'utf8');

    expect(css).toMatch(/pictab-fade-in var\(--background-transition-ms\)/);
    expect(css).toMatch(/pictab-ken-burns-display var\(--background-display-ms\)[^;]*infinite alternate/);
    expect(css).toMatch(/@keyframes pictab-ken-burns-display[\s\S]*translate3d\([^)]*%[\s\S]*scale\(/);
    expect(css).not.toMatch(/background-stage:not\(\[data-transition="none"\]\)[\s\S]{0,120}will-change/);
    expect(css).toMatch(/data-display-motion="ken-burns"[\s\S]{0,180}will-change:\s*transform/);
  });

  it('forces no motion when reduced motion is preferred and reacts to preference changes', () => {
    mockReducedMotion(true);
    render(
      <BackgroundStage
        current={current}
        previous={previous}
        transition="ken-burns"
        transitionMs={1_400}
      />
    );

    expect(screen.getByTestId('background-stage')).toHaveAttribute('data-transition', 'none');
    expect(screen.getByTestId('background-stage')).toHaveAttribute('data-display-motion', 'none');

    act(() => mediaListener?.({ matches: false } as MediaQueryListEvent));
    expect(screen.getByTestId('background-stage')).toHaveAttribute('data-transition', 'ken-burns');
  });
});
