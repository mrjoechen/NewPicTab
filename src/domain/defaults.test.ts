import { describe, expect, it } from 'vitest';

import { createDefaultSettings, DEFAULT_SETTINGS } from './defaults';
import { migrateSettings } from './migrate';

describe('default settings', () => {
  it('deep-freezes the shared default object', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.appearance)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.widgets.clock)).toBe(true);
    expect(() => {
      (DEFAULT_SETTINGS as unknown as { appearance: { transition: string } }).appearance.transition = 'slide';
    }).toThrow(TypeError);
  });

  it('creates independent default and migration result objects', () => {
    const firstFactoryResult = createDefaultSettings();
    const secondFactoryResult = createDefaultSettings();
    const firstMigrationResult = migrateSettings({});
    const secondMigrationResult = migrateSettings({});

    firstFactoryResult.appearance.transition = 'slide';
    firstMigrationResult.widgets.clock.enabled = false;

    expect(secondFactoryResult.appearance.transition).toBe('fade');
    expect(secondMigrationResult.widgets.clock.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.appearance.transition).toBe('fade');
    expect(DEFAULT_SETTINGS.widgets.clock.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.widgets.shortcuts.scale).toBe(1);
  });
});
