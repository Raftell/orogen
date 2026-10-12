// gallery/index.html (testing.md 8.6): that the page holds, per node, what a reviewer reads, that a failed node
// is listed with its error, that nothing a node or a file says is taken for markup, and which failures make
// `gallery` exit with 1. The page is text; nothing is rendered.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countsAsFailure, galleryPage, mib, ms, type GalleryEntry, type GalleryInfo } from '../../../src/cli/gallery-page.ts';
import type { RenderResult } from '../../../src/cli/result.ts';
import { colorize, gen, node, soften } from '../graph-fixtures.ts';

const INFO: GalleryInfo = { res: 513, category: null, device: { adapter: 'NVIDIA <GTX>', software: false, profile: 'max' } };

function rendered(type: string, outputs: readonly string[], more: Partial<RenderResult> = {}): RenderResult {
  const pictures = Object.fromEntries(outputs.map((name) => [name, { file: `nodes/${type}/${name}-513.png`, width: 1808, height: 512 }]));
  return {
    type, res: 513, status: 'ok', errors: [], wallMs: 3.456, gpuMs: 0.5, peakBytes: 3 * 2 ** 20, longestSliceMs: 0.25, longestSliceKernels: [],
    engineErrors: [], files: Object.values(pictures).map((picture) => picture.file), pictures, views: {}, ...more,
  };
}
function failed(type: string, message: string): RenderResult {
  return {
    ...rendered(type, []), status: 'errors', wallMs: 0, gpuMs: null, peakBytes: 0,
    errors: [{ nodeId: 'x1', nodeType: type, kind: 'node-exception', message, detail: `Error: ${message}\n    at evaluate (file:///src/core/nodes/${type}.ts:1:1)` }],
  };
}

const REPORT = JSON.stringify({
  type: 'ref/gen',
  adapter: { description: 'llvmpipe: Mesa 25.2', device: 'llvmpipe', software: true },
  profile: 'core',
  checks: { meta: { result: 'passed' }, resolution: { result: 'skipped', reason: 'Measures <slope>; finer levels resolve steeper faces.' }, seed: { result: 'not-applicable' }, finite: { result: 'failed' } },
  optOuts: [
    { check: 'resolution', kind: 'tolerance', value: 0.05, reason: 'Measures <slope>; finer levels resolve steeper faces.' },
    { check: 'budget', kind: 'skip', reason: 'What it allocates changes with the number of ladder levels.' },
  ],
  budget: { estimateBytes: 1_320_000_000, limitBytes: 3_500_000_000, asserted: false },
}, null, 2);

const twoOutputs = node({
  type: 'ref/select', title: 'Select (Reference)', description: 'Selects <steep> & "flat" ground.', keywords: ['slope', 'mask'],
  inputs: [{ name: 'in', type: 'field' }, { name: 'weights', type: 'field', role: 'mask', label: 'Weight map', optional: true }],
  outputs: [{ name: 'out', type: 'field', role: 'mask' }, { name: 'flow', type: 'field', role: 'data' }],
  resolutionDependent: true,
});
const importer = node({ type: 'io/import', title: 'Import', category: 'io', params: [{ kind: 'file', name: 'file', help: 'The image.', default: '', filters: ['png', 'r16'] }] });

const ENTRIES: readonly GalleryEntry[] = [
  { def: importer, result: failed('io/import', 'No file selected'), conformance: null },
  { def: colorize, result: rendered('ref/colorize', ['out'], { pictures: { out: { file: 'nodes/ref/colorize/out-513.png', width: 513, height: 513 } }, views: { out: { file: 'nodes/ref/colorize/out-513-3d.png', width: 768, height: 512 } } }), conformance: 'not json {' },
  { def: gen, result: rendered('ref/gen', ['out']), conformance: REPORT },
  { def: twoOutputs, result: rendered('ref/select', ['out', 'flow'], { longestSliceMs: 812, longestSliceKernels: ['ref/select.pass'], gpuMs: null, engineErrors: ['Validation <error>'] }), conformance: null },
  { def: soften, result: failed('ref/soften', 'kernel "<script>alert(1)</script>" failed'), conformance: null },
];

const page = galleryPage(INFO, ENTRIES);
/** The article of one node. */
function article(type: string): string {
  const start = page.indexOf(`<article class="node`, page.indexOf(`id="${type.replace('/', '-')}"`) - 60);
  assert.ok(start >= 0, `the page has no article for ${type}`);
  return page.slice(start, page.indexOf('</article>', start));
}

test('the page is one HTML document that names what was rendered and on what', () => {
  assert.ok(page.startsWith('<!doctype html>\n<html lang="en">'));
  assert.ok(page.trimEnd().endsWith('</html>'));
  assert.match(page, /<title>Orogen node gallery<\/title>/);
  assert.match(page, /<p class="quiet">5 nodes at 513 × 513 · <span class="failed">2 not rendered<\/span> · NVIDIA &lt;GTX&gt; · profile max<\/p>/);
  assert.equal(page.split('<article ').length - 1, 5);
  // Nodes are grouped by category, each with a link at the top.
  assert.deepEqual([...page.matchAll(/<h2 id="([a-z]+)">/g)].map((found) => found[1]), ['io', 'ref']);
  for (const type of ['io/import', 'ref/colorize', 'ref/gen', 'ref/select', 'ref/soften']) assert.ok(page.includes(`<a href="#${type.replace('/', '-')}"`), type);
  assert.match(galleryPage({ ...INFO, category: 'ref', device: { adapter: 'llvmpipe', software: true, profile: 'core' } }, ENTRIES.slice(2, 3)), /1 node of the category ref at 513 × 513 · llvmpipe \(a software adapter\) · profile core/);
});

test('a node: title, type, description, keywords, flags, the picture of outputs[0] and what was measured', () => {
  const select = article('ref/select');
  assert.ok(select.includes('<h3>Select (Reference)</h3><code class="type">ref/select</code>'));
  assert.ok(select.includes('<p class="description">Selects &lt;steep&gt; &amp; &quot;flat&quot; ground.</p>'));
  assert.ok(select.includes('<p class="keywords"><span>slope</span><span>mask</span></p>'));
  assert.ok(select.includes('<span class="flag marked">resolutionDependent</span>') && !select.includes('maskable'));
  // The picture is linked from the page's own folder, one below the output folder, and states its size.
  assert.ok(select.includes('<a href="../nodes/ref/select/out-513.png"><img src="../nodes/ref/select/out-513.png" width="1808" height="512" alt="out of ref/select" loading="lazy"></a>'));
  assert.ok(!select.includes('<img src="../nodes/ref/select/flow-513.png"'), 'only outputs[0] is shown');
  assert.match(select, /out at 513 × 513: time 3\.46 ms · GPU time not measured · peak memory 3\.00 MiB · /);
  assert.match(select, /<span class="failed">longest slice 812 ms, above the hard ceiling of 500 ms \(ref\/select\.pass\)<\/span>/);
  assert.match(select, /<span class="failed">GPU error outside every scope: Validation &lt;error&gt;<\/span>/);

  const gallery = article('ref/gen');
  assert.match(gallery, /time 3\.46 ms · GPU 0\.50 ms · peak memory 3\.00 MiB · <span>longest slice 0\.25 ms<\/span>/);
  assert.ok(article('ref/soften').includes('<span class="flag">maskable</span>'));

  // A colour output shows its 3d view beside the colour picture.
  const colored = article('ref/colorize');
  assert.ok(colored.includes('<img src="../nodes/ref/colorize/out-513.png" width="513" height="513"'));
  assert.ok(colored.includes('<img src="../nodes/ref/colorize/out-513-3d.png" width="768" height="512" alt="out of ref/colorize over its height input"'));
});

test('a node: its ports, with the pictures of the outputs linked', () => {
  const select = article('ref/select');
  assert.ok(select.includes('<tr><td>input</td><td><code>in</code></td><td>In</td><td>field, height</td></tr>'), 'the default label is the name with a capital');
  assert.ok(select.includes('<tr><td>input</td><td><code>weights</code></td><td>Weight map</td><td>field, mask, optional</td></tr>'));
  assert.ok(select.includes('<tr><td>output</td><td><code><a href="../nodes/ref/select/out-513.png">out</a></code></td><td>Out</td><td>field, mask</td></tr>'));
  assert.ok(select.includes('<tr><td>output</td><td><code><a href="../nodes/ref/select/flow-513.png">flow</a></code></td><td>Flow</td><td>field, data</td></tr>'));
  assert.ok(select.includes('<p class="quiet">None.</p>'), 'a node without parameters says so');

  const soft = article('ref/soften');
  assert.ok(soft.includes('<td><code>in</code></td><td>In</td><td>any</td>'));
  assert.ok(soft.includes('<td><code>out</code></td><td>Out</td><td>same as in</td>'), 'a failed node has no picture to link');
  assert.ok(article('ref/colorize').includes('<td><code>base</code></td><td>Base</td><td>color, optional</td>'));
});

test('a node: every parameter with label, unit, default, range and help', () => {
  const row = (name: string): string[] => {
    const found = new RegExp(`<tr><td>([^<]*)</td><td><code>${name}</code></td><td>([^<]*)</td><td>([^<]*)</td><td>(.*?)</td><td>([^<]*)</td><td>([^<]*)</td></tr>`).exec(article('ref/gen'));
    assert.ok(found, `no row for the parameter ${name}`);
    return found.slice(1);
  };
  //                             label     kind        unit      default                range                   help
  assert.deepEqual(row('hard'), ['Hard', 'float', 'ratio', '0.5', '0 .. 1', 'Hard limits.']);
  assert.deepEqual(row('soft'), ['Soft', 'float', 'length', '0.25', '0.001 .. 4, soft, log', 'Soft limits.']);
  assert.deepEqual(row('count'), ['Count', 'int', '', '4', '1 .. 16', 'A count.']);
  assert.deepEqual(row('invert'), ['Invert', 'bool', '', 'off', '', 'Inverts.']);
  assert.deepEqual(row('mode'), ['Mode', 'enum', '', 'Mix', 'Mix, Add', 'A choice.']);
  assert.deepEqual(row('seed'), ['Seed', 'seed', '', '0', '0 .. 4294967295', 'A seed.']);
  assert.deepEqual(row('offset'), ['Offset', 'vec2', 'length', '[0, 0]', '-1 .. 1', 'A shift.']);
  assert.deepEqual(row('center'), ['Center', 'vec2', 'length', '[0.5, 0.5]', '0 .. 1, soft', 'A position.']);
  assert.deepEqual(row('tint'), ['Tint', 'color', '', '<span class="swatch" style="background:#ffffff"></span> [1, 1, 1]', '0 .. 1', 'A colour.']);
  assert.deepEqual(row('profile'), ['Profile', 'curve', '', '(0, 0) (1, 1)', '', 'A curve.']);
  assert.deepEqual(row('ramp'), ['Ramp', 'gradient', '', '<span class="swatch" style="background:#000000"></span> 0 <span class="swatch" style="background:#ffffff"></span> 1', '', 'A gradient.']);
  assert.deepEqual(row('file'), ['File', 'file', '', 'no file', '*.png', 'A file.']);
  assert.deepEqual(row('label'), ['Label', 'text', '', '&quot;Layer&quot;', 'at most 8 characters', 'A text.']);
});

test('a node: the conformance report of the output folder, in short and as it is', () => {
  const report = article('ref/gen');
  assert.ok(report.includes('<p class="quiet">Checked on llvmpipe: Mesa 25.2, profile core.</p>'));
  assert.ok(report.includes('<li class="check passed">meta: passed</li>'));
  assert.ok(report.includes('<li class="check skipped" title="Measures &lt;slope&gt;; finer levels resolve steeper faces.">resolution: skipped</li>'));
  assert.ok(report.includes('<li class="check not-applicable">seed: not-applicable</li>'));
  assert.ok(report.includes('<li class="check failed">finite: failed</li>'));
  assert.ok(report.includes('<li><strong>resolution</strong> tolerance 0.05: Measures &lt;slope&gt;; finer levels resolve steeper faces.</li>'));
  assert.ok(report.includes('<li><strong>budget</strong> skipped: What it allocates changes with the number of ladder levels.</li>'));
  assert.ok(report.includes('<p>Budget: 1.32 GB at 8129, not asserted on that device.</p>'));
  // The file's content, every character of it, as text.
  assert.ok(report.includes('<details><summary>conformance/ref/gen.json</summary><pre>{\n  &quot;type&quot;: &quot;ref/gen&quot;,'));
  assert.ok(report.includes('&quot;limitBytes&quot;: 3500000000,'));

  assert.ok(article('ref/select').includes('No conformance report in this output folder'));
  const broken = article('ref/colorize');
  assert.ok(broken.includes('<p class="failed">The report is not JSON.</p>') && broken.includes('<pre>not json {</pre>'));
});

test('a node that fails is listed with its error, and nothing it says is markup', () => {
  const soft = article('ref/soften');
  assert.ok(soft.startsWith('<article class="node broken" id="ref-soften">'));
  assert.ok(soft.includes('<p>Not rendered.</p><pre>ref/soften failed, node-exception: kernel &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot; failed\n  Error: kernel'));
  assert.ok(!soft.includes('<img'), 'a failed node has no picture');
  assert.ok(soft.includes('<h4>Ports</h4>') && soft.includes('<h4>Parameters</h4>'), 'and is described like the others');
  assert.ok(!page.includes('<script'), 'no text of a node reaches the page as an element');
  assert.ok(page.includes('<a href="#ref-soften" class="failed">ref/soften</a>'));

  const imported = article('io/import');
  assert.ok(imported.includes('io/import failed, node-exception: No file selected'));
  assert.ok(imported.includes('The node reads a file and its defaults select none: this error is the documented one.'));
  assert.ok(!soft.includes('this error is the documented one'));
});

test('gallery exits with 1 for a node that fails, unless the node reads a file its defaults do not select', () => {
  assert.deepEqual(ENTRIES.map(countsAsFailure), [false, false, false, false, true]);
  // An import node that fails for another reason still has a file parameter: the page shows the error, a person judges it.
  assert.equal(countsAsFailure({ def: importer, result: failed('io/import', 'Out of GPU memory'), conformance: null }), false);
  assert.equal(countsAsFailure({ def: gen, result: failed('ref/gen', 'No file selected'), conformance: null }), false, 'ref/gen of the fixtures has a file parameter');
  assert.equal(countsAsFailure({ def: colorize, result: { ...rendered('ref/colorize', []), status: 'errors' }, conformance: null }), true);
});

test('a gallery without nodes says so, and names no device', () => {
  const empty = galleryPage({ res: 257, category: 'surface', device: null }, []);
  assert.match(empty, /<p class="quiet">0 nodes of the category surface at 257 × 257<\/p>/);
  assert.ok(empty.includes('<p>The registry has no node with outputs in this selection.</p>'));
  assert.ok(!empty.includes('<article'));
});

test('times and sizes are written for a person', () => {
  assert.deepEqual([ms(0.123), ms(3.456), ms(45.67), ms(812.4), ms(9999), ms(12_345)], ['0.12 ms', '3.46 ms', '45.7 ms', '812 ms', '9999 ms', '12.3 s']);
  assert.deepEqual([mib(0), mib(65_536), mib(3 * 2 ** 20), mib(250 * 2 ** 20), mib(3.5 * 2 ** 30)], ['0.00 MiB', '0.06 MiB', '3.00 MiB', '250 MiB', '3.50 GiB']);
});
