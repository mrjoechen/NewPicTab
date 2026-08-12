import type { NewPicTabSettings } from './types';

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export function createDefaultSettings(): NewPicTabSettings {
  return {
    version: 1,
    interfaceLanguage: 'zh-CN',
    activeSourceId: null,
    sources: [],
    appearance: {
      transition: 'fade',
      transitionMs: 1_200,
      order: 'shuffle',
      changeOn: 'new-tab',
      intervalMinutes: 60
    },
    widgets: {
      clock: { enabled: true, hour12: false, showSeconds: false, size: 'default', scale: 1, position: 'center' },
      date: { enabled: true, format: 'medium', locale: '', showLunar: false },
      weather: {
        enabled: false,
        mode: 'city',
        city: '',
        latitude: null,
        longitude: null,
        animated: true
      },
      search: { enabled: false, engine: 'google' },
      shortcuts: { enabled: false, maxVisible: 6, scale: 1 }
    },
    shortcuts: []
  };
}

export const DEFAULT_SETTINGS: DeepReadonly<NewPicTabSettings> = deepFreeze(createDefaultSettings());
