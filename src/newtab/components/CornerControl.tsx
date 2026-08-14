import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

const HIDE_DELAY_MS = 5_000;

export interface CornerControlProps {
  side: 'left' | 'right';
  children: ReactNode;
}

export function CornerControl({ side, children }: CornerControlProps) {
  const [visible, setVisible] = useState(true);
  const visibleRef = useRef(true);
  const hideTimerRef = useRef<number | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current === null) return;
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => {
      visibleRef.current = false;
      setVisible(false);
      hideTimerRef.current = null;
    }, HIDE_DELAY_MS);
  }, [clearHideTimer]);

  useEffect(() => {
    scheduleHide();
    return clearHideTimer;
  }, [clearHideTimer, scheduleHide]);

  const revealWhenHidden = useCallback(() => {
    if (visibleRef.current) return;
    visibleRef.current = true;
    setVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  return (
    <div
      className={`corner-control corner-control--${side}`}
      data-visible={visible}
      onFocusCapture={revealWhenHidden}
      onPointerEnter={revealWhenHidden}
      onPointerMove={revealWhenHidden}
    >
      {children}
    </div>
  );
}
