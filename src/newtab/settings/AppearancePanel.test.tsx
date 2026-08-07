import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultSettings } from '../../domain/defaults';
import { AppearancePanel } from './AppearancePanel';

afterEach(cleanup);

describe('AppearancePanel', () => {
  it('persists live appearance changes and exposes manual rotation', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onChangeImage = vi.fn();
    function Harness() {
      const [value, setValue] = useState(createDefaultSettings().appearance);
      return <AppearancePanel value={value} onChange={(patch) => { onChange(patch); setValue((current) => ({ ...current, ...patch })); }} onChangeImage={onChangeImage} />;
    }
    render(<Harness />);

    await user.selectOptions(screen.getByLabelText('切换样式'), 'slide');
    expect(onChange).toHaveBeenCalledWith({ transition: 'slide' });
    await user.selectOptions(screen.getByLabelText('换图时机'), 'interval');
    expect(screen.getByLabelText('间隔分钟')).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '立即换图' }));
    expect(onChangeImage).toHaveBeenCalledOnce();
  });
});
