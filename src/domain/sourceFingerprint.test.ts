import { describe, expect, it } from 'vitest';

import { sourceConfigFingerprint } from './sourceFingerprint';
import type { WebDavSourceConfig } from './types';

describe('sourceConfigFingerprint', () => {
  it('includes the separate WebDAV folder path in the remote cache identity', async () => {
    const base: WebDavSourceConfig = {
      id: 'dav',
      name: 'DAV',
      type: 'webdav',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      url: 'https://dav.example/photos/',
      username: 'alice',
      password: 'secret',
      includeSubdirectories: false
    };

    await expect(sourceConfigFingerprint({ ...base, folderPath: ['Family'] }))
      .resolves.not.toBe(await sourceConfigFingerprint({ ...base, folderPath: [] }));
  });
});
