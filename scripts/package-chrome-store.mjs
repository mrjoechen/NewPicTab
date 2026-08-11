#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const IGNORED_NAMES = new Set(['.DS_Store', 'Thumbs.db']);
const FORBIDDEN_DIRECTORIES = new Set(['.git', '__MACOSX', 'node_modules']);
const FORBIDDEN_EXTENSIONS = new Set(['.crx', '.key', '.p12', '.pem', '.pfx']);

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--source', '--output', '--version'].includes(flag) || !value) {
      fail('usage: package-chrome-store.mjs --source <directory> --output <file.zip> --version <version>');
    }
    values[flag.slice(2)] = value;
  }
  if (!values.source || !values.output || !values.version) {
    fail('usage: package-chrome-store.mjs --source <directory> --output <file.zip> --version <version>');
  }
  return values;
}

function toArchivePath(path) {
  return path.split(sep).join('/');
}

function listSubmissionEntries(sourcePath) {
  const entries = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      if (IGNORED_NAMES.has(name)) {
        continue;
      }
      const absolutePath = resolve(directory, name);
      const archivePath = toArchivePath(relative(sourcePath, absolutePath));
      const stats = lstatSync(absolutePath);
      entries.push({ absolutePath, archivePath, name, stats });
      if (stats.isSymbolicLink()) {
        fail(`submission must not contain symlinks: ${archivePath}`);
      }
      if (stats.isDirectory()) {
        visit(absolutePath);
      }
    }
  };
  visit(sourcePath);
  return entries;
}

function assertSafeFiles(entries) {
  const caseInsensitivePaths = new Map();
  for (const entry of entries) {
    const segments = entry.archivePath.split('/');
    if (
      segments.some((segment) => FORBIDDEN_DIRECTORIES.has(segment)) ||
      (!entry.stats.isDirectory() && FORBIDDEN_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    ) {
      fail(`submission contains a forbidden file: ${entry.archivePath}`);
    }

    const foldedPath = entry.archivePath.toLowerCase();
    const existingPath = caseInsensitivePaths.get(foldedPath);
    if (existingPath && existingPath !== entry.archivePath) {
      fail(`submission contains case-conflicting paths: ${existingPath} and ${entry.archivePath}`);
    }
    caseInsensitivePaths.set(foldedPath, entry.archivePath);
  }
}

function isChromeVersion(version) {
  const components = version.split('.');
  return (
    components.length >= 1 &&
    components.length <= 4 &&
    components.every(
      (component) =>
        /^(0|[1-9][0-9]*)$/.test(component) && Number(component) >= 0 && Number(component) <= 65535
    )
  );
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveLocalizedMessage(sourcePath, manifest, value, field) {
  const match = /^__MSG_([A-Za-z0-9_@]+)__$/.exec(value);
  if (!match) {
    return value;
  }
  if (typeof manifest.default_locale !== 'string' || !manifest.default_locale) {
    fail(`manifest ${field} is localized but default_locale is missing`);
  }
  const messagesPath = resolve(
    sourcePath,
    '_locales',
    manifest.default_locale,
    'messages.json'
  );
  if (!existsSync(messagesPath)) {
    fail(`manifest default locale messages are missing: _locales/${manifest.default_locale}/messages.json`);
  }
  const messages = readJson(messagesPath, 'default locale messages');
  const message = messages?.[match[1]]?.message;
  if (typeof message !== 'string' || !message) {
    fail(`manifest ${field} references missing locale message: ${match[1]}`);
  }
  return message;
}

function collectManifestPaths(manifest) {
  const paths = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value) {
      paths.add(value);
    }
  };
  const addValues = (value) => {
    if (typeof value === 'string') {
      add(value);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(add);
    }
  };

  addValues(manifest.icons);
  add(manifest.background?.service_worker);
  addValues(manifest.chrome_url_overrides);
  add(manifest.action?.default_popup);
  addValues(manifest.action?.default_icon);
  add(manifest.options_page);
  add(manifest.options_ui?.page);
  add(manifest.devtools_page);
  add(manifest.side_panel?.default_path);
  manifest.content_scripts?.forEach((script) => {
    script?.js?.forEach(add);
    script?.css?.forEach(add);
  });
  manifest.sandbox?.pages?.forEach(add);
  return paths;
}

function normalizeLocalPath(path) {
  if (isAbsolute(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || path.startsWith('//')) {
    fail(`manifest contains a non-local file reference: ${path}`);
  }
  const normalized = path.replace(/^\/+/, '').replaceAll('\\', '/');
  if (!normalized || normalized.split('/').includes('..')) {
    fail(`manifest contains an unsafe file reference: ${path}`);
  }
  return normalized;
}

function assertManifest(sourcePath, entries, expectedVersion) {
  const manifestPath = resolve(sourcePath, 'manifest.json');
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) {
    fail('manifest.json must be a file at the submission root');
  }
  const manifest = readJson(manifestPath, 'manifest.json');
  if (manifest.manifest_version !== 3) {
    fail('manifest_version must be 3');
  }
  if (!isChromeVersion(manifest.version)) {
    fail(`manifest version is invalid for Chrome: ${String(manifest.version)}`);
  }
  if (manifest.version !== expectedVersion) {
    fail(`manifest version ${manifest.version} does not match release version ${expectedVersion}`);
  }
  if (!isChromeVersion(expectedVersion)) {
    fail(`release version is invalid for Chrome: ${expectedVersion}`);
  }

  for (const [field, maximumLength] of [['name', 75], ['description', 132]]) {
    if (typeof manifest[field] !== 'string' || !manifest[field]) {
      fail(`manifest ${field} is required`);
    }
    const resolvedValue = resolveLocalizedMessage(sourcePath, manifest, manifest[field], field);
    if (resolvedValue.length > maximumLength) {
      fail(`manifest ${field} exceeds ${maximumLength} characters`);
    }
  }
  if (!manifest.icons || typeof manifest.icons !== 'object' || Object.keys(manifest.icons).length === 0) {
    fail('manifest icons are required for Chrome Web Store submission');
  }

  const files = new Set(
    entries.filter((entry) => entry.stats.isFile()).map((entry) => entry.archivePath)
  );
  for (const referencedPath of collectManifestPaths(manifest)) {
    const normalizedPath = normalizeLocalPath(referencedPath);
    if (!files.has(normalizedPath)) {
      fail(`manifest references missing file: ${referencedPath}`);
    }
  }
  return { files, manifest };
}

function assertNoRemoteCode(entries, files) {
  for (const entry of entries) {
    if (!entry.stats.isFile()) {
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (extension === '.html') {
      const html = readFileSync(entry.absolutePath, 'utf8');
      for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi)) {
        const scriptPath = match[2].trim();
        if (/^(?:https?:)?\/\//i.test(scriptPath) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(scriptPath)) {
          fail(`${entry.archivePath} contains a remotely hosted script: ${scriptPath}`);
        }
        const localPath = scriptPath.replace(/[?#].*$/, '').replace(/^\/+/, '');
        if (!files.has(localPath)) {
          fail(`${entry.archivePath} references missing script: ${scriptPath}`);
        }
      }
    }
    if (extension === '.js' || extension === '.mjs') {
      const javascript = readFileSync(entry.absolutePath, 'utf8');
      if (
        /(^|[^A-Za-z0-9_$.])eval\s*\(/m.test(javascript) ||
        /(^|[^A-Za-z0-9_$])new\s+Function\s*\(/m.test(javascript)
      ) {
        fail(`${entry.archivePath} contains eval() or new Function()`);
      }
      if (
        /\bimportScripts\s*\(\s*["'](?:https?:)?\/\//i.test(javascript) ||
        /\bimport\s*\(\s*["'](?:https?:)?\/\//i.test(javascript) ||
        /\bnew\s+(?:Shared)?Worker\s*\(\s*["'](?:https?:)?\/\//i.test(javascript)
      ) {
        fail(`${entry.archivePath} references remotely hosted executable code`);
      }
    }
  }
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, { encoding: 'utf8', ...options });
  if (result.error) {
    fail(`failed to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function assertArchive(outputPath) {
  run('unzip', ['-tqq', outputPath]);
  const entries = run('unzip', ['-Z1', outputPath])
    .split('\n')
    .map((entry) => entry.replace(/^\.\//, '').trim())
    .filter(Boolean);
  if (!entries.includes('manifest.json')) {
    fail('archive must contain manifest.json at its root');
  }
  if (entries.some((entry) => IGNORED_NAMES.has(entry.split('/').at(-1) ?? ''))) {
    fail('archive contains ignored OS metadata');
  }
  if (entries.some((entry) => entry.startsWith('/') || entry.split('/').includes('..'))) {
    fail('archive contains an unsafe path');
  }
  if (statSync(outputPath).size > MAX_PACKAGE_BYTES) {
    fail('archive exceeds the Chrome Web Store 2 GB upload limit');
  }
}

function main() {
  const { source, output, version } = parseArguments(process.argv.slice(2));
  const sourcePath = resolve(source);
  const outputPath = resolve(output);
  if (!existsSync(sourcePath) || !lstatSync(sourcePath).isDirectory()) {
    fail(`build directory does not exist: ${source}`);
  }
  if (extname(outputPath).toLowerCase() !== '.zip') {
    fail('Chrome Web Store submission output must use the .zip extension');
  }
  const relativeOutput = relative(sourcePath, outputPath);
  if (relativeOutput && !relativeOutput.startsWith(`..${sep}`) && relativeOutput !== '..') {
    fail('output archive must be outside the build directory');
  }

  const entries = listSubmissionEntries(sourcePath);
  assertSafeFiles(entries);
  const { files } = assertManifest(sourcePath, entries, version);
  assertNoRemoteCode(entries, files);

  mkdirSync(dirname(outputPath), { recursive: true });
  if (existsSync(outputPath)) {
    if (!lstatSync(outputPath).isFile()) {
      fail(`output path is not a file: ${output}`);
    }
    rmSync(outputPath);
  }
  run('zip', [
    '-q',
    '-X',
    '-9',
    '-r',
    outputPath,
    '.',
    '-x',
    '.DS_Store',
    '*/.DS_Store',
    'Thumbs.db',
    '*/Thumbs.db'
  ], {
    cwd: sourcePath,
    env: { ...process.env, COPYFILE_DISABLE: '1' }
  });
  assertArchive(outputPath);
  process.stdout.write(`Chrome Web Store package ready: ${outputPath}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`Chrome Web Store package error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
