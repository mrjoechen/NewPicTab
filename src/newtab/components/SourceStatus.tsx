import { useMemo, useState } from 'react';

import { copySafeDiagnostic } from '../../lib/redact';
import { Icon } from './Icon';
import { localizeRuntimeMessage, useText } from '../i18n';

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
  const { language, text } = useText();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const diagnostic = useMemo(() => state?.detail === undefined ? '' : copySafeDiagnostic(state.detail, { hideUrls: state.protected === true }), [state?.detail, state?.protected]);
  if (!state) return null;

  const copy = async () => {
    try { await onCopy(diagnostic); setCopied(true); }
    catch { setCopied(false); }
  };

  return <div className={`source-status source-status--${state.status}`}>
    <p role={state.status === 'error' ? 'alert' : 'status'}>{localizeRuntimeMessage(language, LABELS[state.status])}</p>
    {diagnostic && <>
      <button type="button" className="text-button text-button--with-icon" aria-label={expanded ? text('收起技术详情', 'Hide technical details') : text('查看技术详情', 'View technical details')} title={expanded ? text('收起技术详情', 'Hide technical details') : text('查看技术详情', 'View technical details')} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><Icon name={expanded ? 'arrow-up' : 'info'} /><span>{expanded ? text('收起', 'Hide') : text('详情', 'Details')}</span></button>
      {expanded && <div className="source-status__detail"><pre>{diagnostic}</pre><button type="button" className="text-button text-button--with-icon" aria-label={copied ? text('已复制', 'Copied') : text('复制安全详情', 'Copy safe details')} title={copied ? text('已复制', 'Copied') : text('复制安全详情', 'Copy safe details')} onClick={() => void copy()}>{copied ? <Icon name="check" /> : <Icon name="copy" />}<span>{copied ? text('已复制', 'Copied') : text('复制', 'Copy')}</span></button></div>}
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
