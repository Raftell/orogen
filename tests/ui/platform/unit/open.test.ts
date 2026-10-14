// What the bridge opens in the system's default programs, and what it tells of a path (runtime.md 8.6): the
// rules of src/platform/electron/main/open.ts, on a temporary folder. No program is started here; main.ts
// starts one for what these functions let through, and in test mode none.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';

import { MANIFEST_SCHEMA_ID, REPORT_SCHEMA_ID } from '../../../../src/export/manifest.ts';
import { BUILD_SCHEMAS, buildFile, documentFile, externalUrl, isBuildFolder, statPath } from '../../../../src/platform/electron/main/open.ts';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orogen-platform-open-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const REPOSITORY = path.resolve(import.meta.dirname, '../../../..');

function folder(name: string, files: Readonly<Record<string, string>>): string {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

/**
 * Makes a symbolic link, where this account may: on Windows that takes Developer Mode or an administrator, and
 * without it the part of a test that needs the link is left out and said so.
 */
function link(t: TestContext, target: string, at: string): boolean {
  try {
    fs.symlinkSync(target, at);
    return true;
  } catch (thrown) {
    if ((thrown as { code?: unknown }).code !== 'EPERM') throw thrown;
    t.diagnostic(`no link could be made here (${path.basename(at)}): that a link is not followed was not checked`);
    return false;
  }
}

test('open: a web address is http or https, whole, and carries no credentials', () => {
  assert.equal(externalUrl('https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-outdoor-terrain'), 'https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-outdoor-terrain');
  assert.equal(externalUrl('http://example.org'), 'http://example.org/');
  assert.equal(externalUrl('HTTPS://Example.org/a b'), 'https://example.org/a%20b', 'what is opened is the address as it parses');
  for (const refused of [
    'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<p>x', 'ms-settings:privacy', 'smb://host/share', 'mailto:someone@example.org',
    'https://user:secret@example.org/', 'https://user@example.org/', 'example.org', '/home/user/report.json', 'C:\\Windows\\notepad.exe', '', 'https://', ' ',
    `https://example.org/${'a'.repeat(2048)}`,
  ]) assert.equal(externalUrl(refused), null, refused.slice(0, 60));
  for (const refused of [null, undefined, 7, { href: 'https://example.org' }, ['https://example.org']]) assert.equal(externalUrl(refused), null);
});

test('open: a document is a page or a picture of the documentation folder, named from inside it', async (t) => {
  const docs = folder('docs', { 'unreal-import.md': '# Importing', 'images/application.png': 'png', 'examples/ridge.orogen': '{}', 'run.sh': '#!/bin/sh', 'notes.MD': 'x' });
  assert.equal(await documentFile(docs, 'unreal-import.md'), path.join(docs, 'unreal-import.md'));
  assert.equal(await documentFile(docs, 'images/application.png'), path.join(docs, 'images', 'application.png'));
  assert.equal(await documentFile(docs, 'notes.MD'), path.join(docs, 'notes.MD'), 'the kind of a file is its extension, in either case');
  for (const refused of [
    'missing.md', 'images', 'examples/ridge.orogen', 'run.sh', '../docs/unreal-import.md', 'images/../unreal-import.md', './unreal-import.md', '/unreal-import.md',
    'images//application.png', 'images\\application.png', path.join(docs, 'unreal-import.md'), 'C:unreal-import.md', 'unreal-import.md\0.png', '',
  ]) assert.equal(await documentFile(docs, refused), null, JSON.stringify(refused));
  for (const refused of [null, undefined, 3, ['unreal-import.md']]) assert.equal(await documentFile(docs, refused), null);
  // A link is not followed: what it points to may be anything.
  if (link(t, path.join(docs, 'run.sh'), path.join(docs, 'linked.md'))) assert.equal(await documentFile(docs, 'linked.md'), null);
});

test('open: the pages the application names are in the documentation it is given', async () => {
  // docs/user is what a packaged application carries beside its archive (electron-builder.yml).
  const docs = path.join(REPOSITORY, 'docs', 'user');
  for (const name of ['unreal-import.md', 'getting-started.md', 'application.md', 'building.md', 'nodes.md', 'README.md', 'images/application.png']) {
    assert.equal(await documentFile(docs, name), path.join(docs, ...name.split('/')), name);
  }
  const packaging = fs.readFileSync(path.join(REPOSITORY, 'electron-builder.yml'), 'utf8');
  assert.match(packaging, /extraResources:\n(?:\s*#[^\n]*\n)*\s+- from: docs\/user\n\s+to: docs\/user\n/, 'the package carries docs/user as resources/docs/user, where main.ts looks for it');
});

test('open: the schemas a build folder is known by are those the build writes', () => {
  assert.equal(MANIFEST_SCHEMA_ID.startsWith(BUILD_SCHEMAS.manifest), true);
  assert.equal(REPORT_SCHEMA_ID.startsWith(BUILD_SCHEMAS.report), true);
  assert.equal(`${BUILD_SCHEMAS.manifest}1`, MANIFEST_SCHEMA_ID);
  assert.equal(`${BUILD_SCHEMAS.report}1`, REPORT_SCHEMA_ID);
});

test('open: a build file is a file of a kind a build writes, in a folder that holds a build', async (t) => {
  const manifest = JSON.stringify({ schema: MANIFEST_SCHEMA_ID, files: [{ path: 'AlpsHeight.png', bytes: 3 }] });
  const built = folder('built', { 'Alps.orogen.json': manifest, 'Alps.report.json': JSON.stringify({ schema: REPORT_SCHEMA_ID }), 'AlpsHeight.png': 'png', 'AlpsHeight.r16': 'r16', 'LayerRock.r8': 'r8', 'tool.exe': 'MZ', 'run.bat': 'echo', 'notes.txt': 'x', 'sub/Inner.png': 'png' });
  for (const name of ['Alps.orogen.json', 'Alps.report.json', 'AlpsHeight.png', 'AlpsHeight.r16', 'LayerRock.r8']) {
    assert.equal(await buildFile(path.join(built, name)), path.join(built, name), name);
  }
  assert.equal(await buildFile(path.join(built, 'sub', '..', 'AlpsHeight.png')), path.join(built, 'AlpsHeight.png'), 'the path is normalised before it is judged');
  for (const refused of ['tool.exe', 'run.bat', 'notes.txt', 'missing.png', 'sub/Inner.png', 'sub', '']) {
    assert.equal(await buildFile(path.join(built, refused)), null, refused);
  }
  assert.equal(await buildFile(built), null, 'the folder itself is no file: showInFolder shows it');
  assert.equal(await buildFile('AlpsHeight.png'), null, 'a relative path names nothing');
  for (const refused of [null, undefined, 9, {}]) assert.equal(await buildFile(refused), null);

  // What a build that did not succeed leaves is a build folder too: its report, in the staging folder.
  const failed = folder('failed.partial', { 'Alps.report.json': JSON.stringify({ schema: REPORT_SCHEMA_ID, status: 'errors' }) });
  assert.equal(await buildFile(path.join(failed, 'Alps.report.json')), path.join(failed, 'Alps.report.json'));

  // A folder that holds no build is nobody's to open files from, whatever the files are called.
  const plain = folder('plain', { 'Height.png': 'png', 'data.json': '{}' });
  const foreign = folder('foreign', { 'Other.orogen.json': JSON.stringify({ schema: 'someone.else/1' }), 'Broken.report.json': '{ not json', 'Height.png': 'png' });
  assert.deepEqual([await isBuildFolder(built), await isBuildFolder(failed), await isBuildFolder(plain), await isBuildFolder(foreign), await isBuildFolder(path.join(ROOT, 'none'))], [true, true, false, false, false]);
  assert.equal(await buildFile(path.join(plain, 'Height.png')), null);
  assert.equal(await buildFile(path.join(foreign, 'Height.png')), null);

  // A link in a build folder is not followed.
  if (link(t, path.join(built, 'tool.exe'), path.join(built, 'Linked.png'))) assert.equal(await buildFile(path.join(built, 'Linked.png')), null);
});

test('stat: what a path names, with a relative path taken from the project\'s folder', async () => {
  const dir = folder('project', { 'land.orogen': '{}', 'maps/height.png': '12345' });
  const project = path.join(dir, 'land.orogen');
  const file = await statPath(path.join(dir, 'maps', 'height.png'));
  assert.deepEqual([file.exists, file.isFile, file.size], [true, true, 5]);
  assert.equal(file.mtimeMs, fs.statSync(path.join(dir, 'maps', 'height.png')).mtimeMs);
  assert.deepEqual(await statPath('maps/height.png', project), file, 'the stored form of a file under the project folder (6.1 rule 2)');
  const maps = await statPath('maps', project);
  assert.deepEqual([maps.exists, maps.isFile, maps.size], [true, false, 0], 'a folder exists and is no file');

  const absent = { exists: false, isFile: false, size: 0, mtimeMs: 0 };
  assert.deepEqual(await statPath(path.join(dir, 'maps', 'gone.png')), absent);
  assert.deepEqual(await statPath('maps/gone.png', project), absent);
  assert.deepEqual(await statPath('maps/height.png'), absent, 'a relative path of a project that was never saved names nothing');
  assert.deepEqual(await statPath('maps/height.png', null), absent);
  assert.deepEqual(await statPath('maps/height.png', 'land.orogen'), absent, 'nor one beside a project path that is not absolute');
  assert.deepEqual(await statPath(''), absent);
  assert.deepEqual(await statPath(path.join(dir, 'land.orogen', 'inside')), absent, 'a path through a file names nothing');
  await assert.rejects(statPath(undefined), TypeError);
  await assert.rejects(statPath({ path: '/' }), TypeError);
});
