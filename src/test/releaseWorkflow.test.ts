import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const workflowPath = resolve(process.cwd(), '.github/workflows/release.yml');
const workflow = readFileSync(workflowPath, 'utf8');
const validationScript = extractRunScript('Validate release version');
const packagingScript = extractRunScript('Package Chrome Web Store submission');
const releaseScript = extractRunScript('Create GitHub Release');
const temporaryDirectories: string[] = [];

function extractRunScript(stepName: string): string {
  const stepMarker = `      - name: ${stepName}\n`;
  const stepStart = workflow.indexOf(stepMarker);
  if (stepStart === -1) throw new Error(`release workflow step is missing: ${stepName}`);

  const runMarker = '        run: |\n';
  const runStart = workflow.indexOf(runMarker, stepStart);
  if (runStart === -1) throw new Error(`release workflow run block is missing: ${stepName}`);

  const scriptStart = runStart + runMarker.length;
  const nextStep = workflow.indexOf('\n      - name:', scriptStart);
  const script = workflow.slice(scriptStart, nextStep === -1 ? undefined : nextStep);
  return script.replace(/^ {10}/gm, '').trimEnd();
}

function createReleaseFixture(packageVersion: string, manifestVersion: string): string {
  const root = mkdtempSync(join(tmpdir(), 'newpictab-release-workflow-'));
  temporaryDirectories.push(root);
  mkdirSync(join(root, 'public'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: packageVersion }));
  writeFileSync(join(root, 'public/manifest.json'), JSON.stringify({ version: manifestVersion }));
  return root;
}

function runValidation(cwd: string, releaseTag: string) {
  return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', validationScript], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, RELEASE_TAG: releaseTag }
  });
}

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('release workflow', () => {
  it('uses the manifest as the only release version source', () => {
    const fixture = createReleaseFixture('9.9.9', '1.2.3');

    const result = runValidation(fixture, 'v1.2.3');

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('rejects a release tag that differs from the manifest version', () => {
    const fixture = createReleaseFixture('1.2.4', '1.2.3');

    const result = runValidation(fixture, 'v1.2.4');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Tag and public/manifest.json versions must match.');
    expect(result.stderr).toContain('tag=1.2.4 manifest=1.2.3');
  });

  it('rejects release tags outside the exact vX.Y.Z format', () => {
    const fixture = createReleaseFixture('1.2.3', '1.2.3');

    const result = runValidation(fixture, '1.2.3');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Expected a semantic version tag such as v1.2.3');
  });

  it('passes the tag-derived version to the store packaging command', () => {
    const fixture = createReleaseFixture('9.9.9', '1.2.3');
    const binPath = join(fixture, 'bin');
    const capturedArgumentsPath = join(fixture, 'npm-arguments.txt');
    mkdirSync(binPath);
    writeExecutable(join(binPath, 'npm'), `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$CAPTURED_ARGUMENTS_PATH"
archive=''
while (( "$#" )); do
  if [[ "$1" == '--output' ]]; then
    archive="$2"
    break
  fi
  shift
done
: > "$archive"
`);
    writeExecutable(join(binPath, 'sha256sum'), `#!/usr/bin/env bash
printf 'checksum  %s\\n' "$1"
`);

    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', packagingScript], {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        CAPTURED_ARGUMENTS_PATH: capturedArgumentsPath,
        PATH: `${binPath}:${process.env.PATH ?? ''}`,
        RELEASE_TAG: 'v1.2.3'
      }
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(capturedArgumentsPath, 'utf8').trim().split('\n')).toEqual([
      'run',
      'package:chrome-store',
      '--',
      '--source',
      'dist',
      '--output',
      'newpictab-v1.2.3.zip',
      '--version',
      '1.2.3'
    ]);
  });

  it('uploads release assets using their archive filenames', () => {
    const fixture = createReleaseFixture('9.9.9', '1.2.3');
    const archive = 'newpictab-v1.2.3.zip';
    const capturedArgumentsPath = join(fixture, 'gh-arguments.txt');
    const binPath = join(fixture, 'bin');
    mkdirSync(binPath);
    writeFileSync(join(fixture, archive), 'zip');
    writeFileSync(join(fixture, `${archive}.sha256`), 'checksum');
    writeExecutable(join(binPath, 'gh'), `#!/usr/bin/env bash
if [[ "$1" == 'release' && "$2" == 'view' ]]; then
  exit 0
fi
printf '%s\\n' "$@" > "$CAPTURED_ARGUMENTS_PATH"
`);

    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', releaseScript], {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        CAPTURED_ARGUMENTS_PATH: capturedArgumentsPath,
        PATH: `${binPath}:${process.env.PATH ?? ''}`,
        RELEASE_TAG: 'v1.2.3'
      }
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(capturedArgumentsPath, 'utf8').trim().split('\n')).toEqual([
      'release',
      'upload',
      'v1.2.3',
      archive,
      `${archive}.sha256`,
      '--clobber'
    ]);
  });
});
