import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import type { TransitionName } from '../../domain/types';
import type { BackgroundDirection, BackgroundImage } from '../hooks/useBackgroundRotation';

export interface BackgroundStageProps {
  current: BackgroundImage | null;
  previous: BackgroundImage | null;
  transition: TransitionName;
  transitionMs: number;
  /** Duration of the slow pan and scale while a Ken Burns image is displayed. */
  kenBurnsMs?: number;
  direction?: BackgroundDirection;
}

type StageStyle = CSSProperties & {
  '--background-transition-ms': string;
  '--background-display-ms': string;
};

function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() =>
    typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

function backgroundStyle(image: BackgroundImage | null): CSSProperties | undefined {
  return image ? { backgroundImage: `url(${JSON.stringify(image.url)})` } : undefined;
}

function restartLayerAnimations(elements: readonly (HTMLImageElement | null)[]): void {
  const mounted = elements.filter((element): element is HTMLImageElement => element !== null);
  for (const element of mounted) element.style.animation = 'none';
  if (mounted[0]) void mounted[0].offsetWidth;
  for (const element of mounted) element.style.removeProperty('animation');
}

export function BackgroundStage({
  current,
  previous,
  transition,
  transitionMs,
  kenBurnsMs = 32_000,
  direction = 'next'
}: BackgroundStageProps) {
  const reducedMotion = usePrefersReducedMotion();
  const effectiveTransition = reducedMotion ? 'none' : transition;
  const displayMotion = effectiveTransition === 'ken-burns' ? 'ken-burns' : 'none';
  const safeDuration = Number.isFinite(transitionMs) ? Math.max(0, transitionMs) : 0;
  const safeDisplayDuration = Number.isFinite(kenBurnsMs) ? Math.max(1_000, kenBurnsMs) : 32_000;
  const style: StageStyle = {
    '--background-transition-ms': `${safeDuration}ms`,
    '--background-display-ms': `${safeDisplayDuration}ms`
  };
  const previousLayerRef = useRef<HTMLImageElement>(null);
  const currentLayerRef = useRef<HTMLImageElement>(null);
  const transitionPair = `${previous?.sourceId ?? ''}\u0000${previous?.id ?? ''}\u0001${current?.sourceId ?? ''}\u0000${current?.id ?? ''}`;
  const lastTransitionPair = useRef(transitionPair);

  useLayoutEffect(() => {
    if (lastTransitionPair.current === transitionPair) return;
    lastTransitionPair.current = transitionPair;
    restartLayerAnimations([previousLayerRef.current, currentLayerRef.current]);
  }, [transitionPair]);

  return (
    <div
      className="background-stage"
      data-testid="background-stage"
      data-transition={effectiveTransition}
      data-display-motion={displayMotion}
      data-direction={direction}
      style={style}
      aria-hidden="true"
    >
      <img
        ref={previousLayerRef}
        className="background-stage__layer background-stage__layer--previous"
        data-testid="background-previous"
        data-source-id={previous?.sourceId}
        data-image-id={previous?.id}
        src={previous?.url}
        alt=""
        decoding="async"
        style={backgroundStyle(previous)}
      />
      <img
        ref={currentLayerRef}
        className="background-stage__layer background-stage__layer--current"
        data-testid="background-current"
        data-source-id={current?.sourceId}
        data-image-id={current?.id}
        src={current?.url}
        alt=""
        decoding="async"
        style={backgroundStyle(current)}
      />
      <div className="background-stage__scrim" />
    </div>
  );
}
