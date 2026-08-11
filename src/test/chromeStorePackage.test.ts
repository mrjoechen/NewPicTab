import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const packageScript = resolve(process.cwd(), 'scripts/package-chrome-store.mjs');
const temporaryDirectories: string[] = [];

function createFixture(): { outputPath: string; sourcePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'pictab-chrome-store-'));
  temporaryDirectories.push(root);
  const sourcePath = join(root, 'dist');
  const outputPath = join(root, 'pictab-v1.2.3-chrome-store.zip');
  mkdirSync(join(sourcePath, 'icons'), { recursive: true });
  mkdirSync(join(sourcePath, 'assets'), { recursive: true });
  writeFileSync(join(sourcePath, 'icons/icon-128.png'), 'icon');
  writeFileSync(join(sourcePath, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  writeFileSync(join(sourcePath, 'assets/newtab.js'), 'document.body.dataset.ready = "true";');
  writeFileSync(
    join(sourcePath, 'newtab.html'),
    '<!doctype html><script type="module" src="/assets/newtab.js"></script>'
  );
  writeFileSync(
    join(sourcePath, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'PicTab',
      description: 'A new tab extension.',
      version: '1.2.3',
      icons: { 128: 'icons/icon-128.png' },
      background: { service_worker: 'background.js', type: 'module' },
      chrome_url_overrides: { newtab: 'newtab.html' }
    })
  );
  return { outputPath, sourcePath };
}

function packageFixture(sourcePath: string, outputPath: string) {
  return spawnSync(
    process.execPath,
    [packageScript, '--source', sourcePath, '--output', outputPath, '--version', '1.2.3'],
    { encoding: 'utf8' }
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('Chrome Web Store package script', () => {
  it('creates an upload-ready zip with manifest.json at the archive root', () => {
    const { outputPath, sourcePath } = createFixture();

    const result = packageFixture(sourcePath, outputPath);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const entries = execFileSync('unzip', ['-Z1', outputPath], { encoding: 'utf8' })
      .trim()
      .split('\n');
    expect(entries).toContain('manifest.json');
    expect(entries).toContain('background.js');
    expect(entries).not.toContain('dist/manifest.json');
  });

  it('omits OS metadata from the upload zip', () => {
    const { outputPath, sourcePath } = createFixture();
    writeFileSync(join(sourcePath, '.DS_Store'), 'finder metadata');
    writeFileSync(join(sourcePath, 'assets/Thumbs.db'), 'windows metadata');

    const result = packageFixture(sourcePath, outputPath);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const entries = execFileSync('unzip', ['-Z1', outputPath], { encoding: 'utf8' })
      .trim()
      .split('\n');
    expect(entries).not.toContain('.DS_Store');
    expect(entries).not.toContain('assets/Thumbs.db');
  });

  it('rejects a manifest version that differs from the release version', () => {
    const { outputPath, sourcePath } = createFixture();

    const result = spawnSync(
      process.execPath,
      [packageScript, '--source', sourcePath, '--output', outputPath, '--version', '1.2.4'],
      { encoding: 'utf8' }
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('manifest version 1.2.3 does not match release version 1.2.4');
  });

  it('rejects missing files referenced by the manifest', () => {
    const { outputPath, sourcePath } = createFixture();
    rmSync(join(sourcePath, 'background.js'));

    const result = packageFixture(sourcePath, outputPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('manifest references missing file: background.js');
  });

  it('rejects remotely hosted scripts and dynamic string execution', () => {
    const remoteFixture = createFixture();
    writeFileSync(
      join(remoteFixture.sourcePath, 'newtab.html'),
      '<!doctype html><script src="https://example.com/app.js"></script>'
    );
    const dynamicFixture = createFixture();
    writeFileSync(join(dynamicFixture.sourcePath, 'background.js'), 'eval("alert(1)");');

    const remoteResult = packageFixture(remoteFixture.sourcePath, remoteFixture.outputPath);
    const dynamicResult = packageFixture(dynamicFixture.sourcePath, dynamicFixture.outputPath);

    expect(remoteResult.status).not.toBe(0);
    expect(remoteResult.stderr).toContain('newtab.html contains a remotely hosted script');
    expect(dynamicResult.status).not.toBe(0);
    expect(dynamicResult.stderr).toContain('background.js contains eval() or new Function()');
  });

  it('rejects symlinks and private keys from the submission', () => {
    const symlinkFixture = createFixture();
    symlinkSync('background.js', join(symlinkFixture.sourcePath, 'linked-background.js'));
    const privateKeyFixture = createFixture();
    writeFileSync(join(privateKeyFixture.sourcePath, 'extension.pem'), 'private key');

    const symlinkResult = packageFixture(symlinkFixture.sourcePath, symlinkFixture.outputPath);
    const privateKeyResult = packageFixture(privateKeyFixture.sourcePath, privateKeyFixture.outputPath);

    expect(symlinkResult.status).not.toBe(0);
    expect(symlinkResult.stderr).toContain('submission must not contain symlinks: linked-background.js');
    expect(privateKeyResult.status).not.toBe(0);
    expect(privateKeyResult.stderr).toContain('submission contains a forbidden file: extension.pem');
  });
});
