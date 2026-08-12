import type { NewPicTabSettings } from '../domain/types';
import { clearAllLocalData } from '../storage/imageDb';
import * as settingsStore from '../storage/settingsStore';
import type { BackgroundResponse } from '../background/messages';
import { sendBackgroundRequest } from './sourceClient';
import { withNewPicTabDataClearLock } from '../storage/maintenance';

export interface DataClearDependencies {
  clearSettings: () => Promise<NewPicTabSettings>;
  clearLocal: () => Promise<void>;
  clearWorker: () => Promise<BackgroundResponse>;
}

export type DataClearResult = { ok: true; settings: NewPicTabSettings } | { ok: false; failures: string[] };

const DEFAULT_DEPENDENCIES: DataClearDependencies = {
  clearSettings: settingsStore.clearInsideDataMaintenance,
  // The enclosing data lock is already exclusive. Waiting on the longer-lived
  // local import lease here would deadlock a source that is awaiting its save.
  clearLocal: clearAllLocalData,
  clearWorker: () => sendBackgroundRequest({ system: 'clear-all-data' })
};
const SAFE_WORKER_FAILURES = new Set(['source adapters', 'remote image cache', 'remote image catalog', 'weather cache', 'browser journals and cursors']);

/** Clears independent storage backends without ever propagating sensitive exception text. */
export async function clearAllNewPicTabData(dependencies: DataClearDependencies = DEFAULT_DEPENDENCIES): Promise<DataClearResult> {
  return withNewPicTabDataClearLock(() => clearAllNewPicTabDataInsideLock(dependencies));
}

async function clearAllNewPicTabDataInsideLock(dependencies: DataClearDependencies): Promise<DataClearResult> {
  const [settingsResult, localResult, workerResult] = await Promise.allSettled([
    dependencies.clearSettings(),
    dependencies.clearLocal(),
    dependencies.clearWorker()
  ]);
  const failures: string[] = [];
  if (settingsResult.status === 'rejected') failures.push('settings and credentials');
  if (localResult.status === 'rejected') failures.push('local images and journals');
  if (workerResult.status === 'rejected') failures.push('remote cache, catalog, weather, and cursors');
  else if (!workerResult.value.ok) {
    const reported = 'failures' in workerResult.value && Array.isArray(workerResult.value.failures) ? workerResult.value.failures : [];
    failures.push(...(reported.length > 0 && reported.every((failure) => SAFE_WORKER_FAILURES.has(failure)) ? reported : ['remote cache, catalog, weather, and cursors']));
  }
  if (failures.length || settingsResult.status === 'rejected') return { ok: false, failures: [...new Set(failures)] };
  return { ok: true, settings: settingsResult.value };
}
