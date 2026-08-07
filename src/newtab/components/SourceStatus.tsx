import { useMemo, useState } from 'react';

import { copySafeDiagnostic } from '../../lib/redact';
import { Icon } from './Icon';

export interface SourceStatusState {
  status: 'loading' | 'ready' | 'stale' | 'error';
  message?: string;
  detail?: unknown;
  protected?: boolean;
}

export interface SourceStatusProps {
  state?: SourceStatusState;
  onCopy?: (value: string) => void | Promise<void>;
}

const LABELS: Record<SourceStatusState['status'], string> = {
  loading: '正在载入图片…',
  ready: '连接正常。',
  stale: '刷新失败，正在使用缓存。',
  error: '无法载入图片，请检查配置后重试。'
};

export function SourceStatus({ state, onCopy = copyText }: SourceStatusProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const diagnostic = useMemo(() => state?.detail === undefined ? '' : copySafeDiagnostic(state.detail, { hideUrls: state.protected === true }), [state?.detail, state?.protected]);
  if (!state) return null;

  const copy = async () => {
    try { await onCopy(diagnostic); setCopied(true); }
    catch { setCopied(false); }
  };

  return <div className={`source-status source-status--${state.status}`}>
    <p role={state.status === 'error' ? 'alert' : 'status'}>{LABELS[state.status]}</p>
    {diagnostic && <>
      <button type="button" className="text-button text-button--with-icon" aria-label={expanded ? '收起技术详情' : '查看技术详情'} title={expanded ? '收起技术详情' : '查看技术详情'} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><Icon name={expanded ? 'arrow-up' : 'info'} /><span>{expanded ? '收起' : '详情'}</span></button>
      {expanded && <div className="source-status__detail"><pre>{diagnostic}</pre><button type="button" className="text-button text-button--with-icon" aria-label={copied ? '已复制' : '复制安全详情'} title={copied ? '已复制' : '复制安全详情'} onClick={() => void copy()}>{copied ? <Icon name="check" /> : <Icon name="copy" />}<span>{copied ? '已复制' : '复制'}</span></button></div>}
    </>}
  </div>;
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  try {
    if (!document.execCommand?.('copy')) throw new Error('Copy unavailable');
  } finally { textarea.remove(); }
}
