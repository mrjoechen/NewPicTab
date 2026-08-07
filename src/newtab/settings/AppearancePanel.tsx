import type { AppearanceSettings } from '../../domain/types';
import { Icon } from '../components/Icon';

export interface AppearancePanelProps {
  value: AppearanceSettings;
  onChange: (patch: Partial<AppearanceSettings>) => void | Promise<void>;
  onChangeImage: () => void | Promise<void>;
}

export function AppearancePanel({ value, onChange, onChangeImage }: AppearancePanelProps) {
  const patch = (change: Partial<AppearanceSettings>) => void onChange(change);

  return (
    <section className="settings-section" aria-labelledby="appearance-title">
      <header className="settings-section__header">
        <p className="settings-eyebrow">显示</p>
        <h2 id="appearance-title">背景与动效</h2>
        <p>只调整图片的出现方式，不遮挡画面。</p>
      </header>
      <div className="settings-form">
        <label className="field">
          <span>切换样式</span>
          <select value={value.transition} onChange={(event) => patch({ transition: event.target.value as AppearanceSettings['transition'] })}>
            <option value="fade">淡入淡出</option>
            <option value="slide">滑动</option>
            <option value="ken-burns">缓慢推移</option>
            <option value="none">无动效</option>
          </select>
        </label>
        <label className="field">
          <span>动效时长</span>
          <select value={value.transitionMs} onChange={(event) => patch({ transitionMs: Number(event.target.value) })} disabled={value.transition === 'none'}>
            <option value="300">快速 · 0.3 秒</option>
            <option value="700">自然 · 0.7 秒</option>
            <option value="1200">舒缓 · 1.2 秒</option>
            <option value="2000">缓慢 · 2 秒</option>
          </select>
        </label>
        <label className="field">
          <span>图片顺序</span>
          <select value={value.order} onChange={(event) => patch({ order: event.target.value as AppearanceSettings['order'] })}>
            <option value="shuffle">随机</option>
            <option value="sequential">顺序</option>
          </select>
        </label>
        <label className="field">
          <span>换图时机</span>
          <select value={value.changeOn} onChange={(event) => patch({ changeOn: event.target.value as AppearanceSettings['changeOn'] })}>
            <option value="new-tab">每次打开新标签页</option>
            <option value="interval">按时间间隔</option>
          </select>
        </label>
        <label className="field">
          <span>间隔分钟</span>
          <input type="number" min="1" max="1440" value={value.intervalMinutes} disabled={value.changeOn !== 'interval'} onChange={(event) => patch({ intervalMinutes: Math.min(1440, Math.max(1, Number(event.target.value) || 1)) })} />
        </label>
      </div>
      <button className="button button--secondary button--with-icon" type="button" aria-label="立即换图" title="立即换图" onClick={() => void onChangeImage()}><Icon name="refresh" /><span>换图</span></button>
    </section>
  );
}
