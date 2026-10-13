// How the build panel writes sizes, times and lengths, and what it does with paths: the page has no file
// system, so a path is text, written as the platform that returned it writes it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FOLDER_RULES, folderWarning, sharedWith } from '../../../../src/app/panels/build/model/folder.ts';
import { formatBytes, formatCount, formatDuration, formatEstimate, formatLength, formatPercent, plural } from '../../../../src/app/panels/build/model/format.ts';
import { baseName, contains, folderOf, isRoot, joinPath, sameFolder, shortPath, trimPath } from '../../../../src/app/panels/build/model/paths.ts';

test('a size is written in the units of the status bar, and a small file is not "0 MB"', () => {
  assert.deepEqual(
    [0, 812, 1024, 4300, 116_162, 2 ** 20, 5.7 * 2 ** 20, 16_289_296, 132_161_282, 2 ** 30, 3.6 * 2 ** 30, 12 * 2 ** 30].map(formatBytes),
    ['0 B', '812 B', '1.0 KB', '4.2 KB', '113 KB', '1.0 MB', '5.7 MB', '16 MB', '126 MB', '1.0 GB', '3.6 GB', '12.0 GB'],
  );
  // No unit is left for the next one to round into: 1023.7 KB is not "1024 KB".
  assert.equal(formatBytes(2 ** 20 - 200), '1.0 MB');
  assert.equal(formatBytes(2 ** 30 - 2000), '1.0 GB');
  assert.deepEqual([Number.NaN, -1, Infinity].map(formatBytes), ['', '', '']);
});

test('a measured time is written to a tenth of a second, an estimated one no finer than it is known', () => {
  assert.deepEqual([0, 440, 9900, 9960, 59_400, 200_000, 3_900_000].map(formatDuration), ['0.0 s', '0.4 s', '9.9 s', '10 s', '59 s', '3 min 20 s', '1 h 05 min']);
  assert.deepEqual(
    [0, 4000, 7000, 33_000, 58_000, 75_000, 100_000, 290_000, 600_000, 3_540_000, 4_200_000].map(formatEstimate),
    ['a few seconds', 'a few seconds', '5 s', '35 s', '1 min', '1 min 30 s', '1 min 30 s', '5 min', '10 min', '59 min', '1 h 10 min'],
  );
  assert.deepEqual([Number.NaN, -5].map(formatEstimate), ['', '']);
});

test('lengths, counts and shares', () => {
  assert.deepEqual([1.984126984, 1, 0.496031746, 0.25, 250, 2500, 0].map(formatLength), ['1.98 m', '1 m', '49.6 cm', '25 cm', '250 m', '2.5 km', '0 m']);
  // A terrain of one meter at 2049 has vertices half a millimeter apart: not "0.0488 cm".
  assert.deepEqual([1 / 2048, 0.01, 0.0099, 1 / 8128].map(formatLength), ['0.488 mm', '1 cm', '9.9 mm', '0.123 mm']);
  assert.deepEqual([0, 999, 1009, 66_080_641].map(formatCount), ['0', '999', '1,009', '66,080,641']);
  assert.deepEqual([0, 0.004, 0.426, 1, 1.4, -0.2].map(formatPercent), ['0 %', '0 %', '43 %', '100 %', '100 %', '0 %']);
  assert.deepEqual([plural(1, 'file'), plural(8, 'file'), plural(1, 'entry', 'entries'), plural(1200, 'entry', 'entries')], ['1 file', '8 files', '1 entry', '1,200 entries']);
});

test('paths are joined, cut and compared in the notation they are written in', () => {
  assert.equal(joinPath('/home/ada/Builds/Ridge', 'Ridge.orogen.json'), '/home/ada/Builds/Ridge/Ridge.orogen.json');
  assert.equal(joinPath('/home/ada/Builds/Ridge/', 'a.png'), '/home/ada/Builds/Ridge/a.png');
  assert.equal(joinPath('D:\\Build\\Ridge', 'RidgeHeight.png'), 'D:\\Build\\Ridge\\RidgeHeight.png');
  assert.equal(joinPath('D:\\', 'x'), 'D:\\x');
  assert.equal(joinPath('/', 'x'), '/x');
  // A Windows path written with forward slashes stays one.
  assert.equal(joinPath('D:/Build/Ridge', 'a.png'), 'D:/Build/Ridge/a.png');

  assert.deepEqual(['/a/b/c.orogen', '/c.orogen', 'D:\\p\\c.orogen', 'D:\\c.orogen', 'c.orogen'].map(folderOf), ['/a/b', '/', 'D:\\p', 'D:\\', '']);
  assert.deepEqual(['/a/b/c.orogen', '/a/b/', 'D:\\p\\Ridge', 'Ridge'].map(baseName), ['c.orogen', 'b', 'Ridge', 'Ridge']);
  assert.deepEqual(['/a/b//', '/', 'D:\\', 'D:\\a\\'].map(trimPath), ['/a/b', '/', 'D:\\', 'D:\\a']);

  assert.equal(sameFolder('/a/b', '/a/b/'), true);
  assert.equal(sameFolder('/a/b', '/a/B'), false, 'a POSIX path is compared as it is written');
  assert.equal(sameFolder('D:\\Build\\Ridge', 'd:/build/ridge/'), true, 'a Windows path is not');
  assert.equal(sameFolder('/a/b', '/a/bc'), false);
  assert.equal(contains('/a', '/a/b/c'), true);
  assert.equal(contains('/a/b', '/a/b'), false, 'a folder does not contain itself');
  assert.equal(contains('/a/b', '/a/bc'), false);
  assert.equal(contains('D:\\', 'D:\\Build'), true);
  assert.deepEqual(['/', 'C:\\', 'c:/', '/a', 'C:\\a', '\\\\server\\share'].map(isRoot), [true, true, true, false, false, false]);
});

test('a long path is shown by its end, which is what tells two build folders apart', () => {
  assert.equal(shortPath('/home/ada/Builds/Ridge', 40), '/home/ada/Builds/Ridge');
  assert.equal(shortPath('/home/ada/Projects/Terrain/Builds/Ridge', 20), '…/Builds/Ridge');
  assert.equal(shortPath('D:\\Projects\\Terrain\\Builds\\Ridge', 16), '…\\Builds\\Ridge');
  const tight = shortPath('/a/AVeryLongFolderNameThatDoesNotFit', 12);
  assert.ok(tight.length <= 12 && tight.startsWith('…') && tight.endsWith('NotFit'), tight);
});

test('what the two paths say of an output folder: the root of a drive, the project\'s folder and a folder around it are refused for certain', () => {
  const project = '/home/ada/Terrain/ridge.orogen';
  assert.equal(folderWarning('/home/ada/Builds/Ridge', project), null);
  assert.equal(folderWarning('/home/ada/Terrain/Build', project), null, 'a folder of its own inside the project\'s folder is a folder of its own');
  assert.match(folderWarning('/home/ada/Terrain', project)!, /^This folder holds the project file/);
  assert.match(folderWarning('/home/ada/Terrain/', project)!, /^This folder holds the project file/);
  assert.match(folderWarning('/home/ada', project)!, /^The project lies inside this folder/);
  assert.match(folderWarning('/', project)!, /^This is the root of a drive/);
  assert.match(folderWarning('D:\\', null)!, /^This is the root of a drive/);
  assert.match(folderWarning('d:\\terrain', 'D:\\Terrain\\ridge.orogen')!, /^This folder holds the project file/);
  // A project that has no file yet has no folder to protect.
  assert.equal(folderWarning('/home/ada/Terrain', null), null);
  // Each warning is one sentence without a full stop: the panel goes on after it (testing.md 6.2).
  for (const said of [folderWarning('/', project)!, folderWarning('/home/ada/Terrain', project)!, folderWarning('/home/ada', project)!]) assert.doesNotMatch(said, /\.$/);
});

test('two projects that build into one folder replace each other\'s builds: the panel knows the folders it was given, and says so', () => {
  const folders = { '/home/ada/Terrain/ridge.orogen': '/home/ada/Builds/Ridge', '/home/ada/Terrain/dunes.orogen': '/home/ada/Builds/Ridge/', '/home/ada/Terrain/coast.orogen': '/home/ada/Builds/Coast', '': '/home/ada/Builds/Ridge' };
  // The project that is open is not another project, and neither is one without a file.
  assert.deepEqual(sharedWith('/home/ada/Builds/Ridge', '/home/ada/Terrain/ridge.orogen', folders), ['/home/ada/Terrain/dunes.orogen']);
  assert.deepEqual(sharedWith('/home/ada/Builds/Ridge', null, folders), ['/home/ada/Terrain/dunes.orogen', '/home/ada/Terrain/ridge.orogen']);
  assert.deepEqual(sharedWith('/home/ada/Builds/Coast', '/home/ada/Terrain/coast.orogen', folders), []);
  assert.deepEqual(sharedWith('/home/ada/Builds/New', '/home/ada/Terrain/ridge.orogen', folders), []);
  // One folder in two spellings, as Windows writes it.
  assert.deepEqual(sharedWith('d:/builds/ridge/', 'D:\\P\\b.orogen', { 'D:\\P\\a.orogen': 'D:\\Builds\\Ridge', 'D:\\P\\b.orogen': 'D:\\Builds\\Ridge' }), ['D:\\P\\a.orogen']);
});

test('the rules of the output folder are those of the pipeline (export-unreal.md 3.8)', () => {
  const said = FOLDER_RULES.join(' ');
  for (const part of ['replaces everything', 'new, empty', 'earlier Orogen build and nothing else', 'refused and not touched', 'Never the folder of the project file']) {
    assert.ok(said.includes(part), part);
  }
});
