import { useCallback, useEffect, useState } from 'react';

import { getLocal, setLocal } from '../../lib/chrome';
import { withAuxiliaryStorageWriteLock } from '../../storage/maintenance';
import { Icon } from './Icon';

export const FIRST_RUN_DISMISSED_KEY = 'pictab-first-run-dismissed-v1';

export interface FirstRunProps {
  hasConfiguredSource: boolean;
  dismissRequest?: number;
  onOpenSources: () => void;
}

export function FirstRun({ hasConfiguredSource, dismissRequest = 0, onOpenSources }: FirstRunProps) {
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    void getLocal<unknown>(FIRST_RUN_DISMISSED_KEY).then((value) => {
      if (active) setDismissed((current) => current === true ? true : value === true);
    });
    return () => { active = false; };
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    void withAuxiliaryStorageWriteLock(() => setLocal(FIRST_RUN_DISMISSED_KEY, true)).catch(() => setDismissed(false));
  }, []);

  useEffect(() => {
    if (dismissRequest > 0) dismiss();
  }, [dismiss, dismissRequest]);

  if (hasConfiguredSource || dismissed !== false) return null;

  const openSources = () => {
    dismiss();
    onOpenSources();
  };

  return <aside className="first-run" aria-label="开始使用 PicTab">
    <div className="first-run__copy"><strong>添加你的图片</strong><span>连接一个图片源，或继续使用默认背景。</span></div>
    <div className="first-run__actions">
      <button type="button" className="first-run__action first-run__action--primary icon-button" aria-label="添加图片源" title="添加图片源" onClick={openSources}><Icon name="plus" /></button>
    </div>
  </aside>;
}
