// gallery/<category>.html and gallery/index.html (testing.md 8.6): that a page holds, per node, what a reviewer
// reads, that a failed node is listed with its error, that nothing a node or a file says is taken for markup,
// which failures make `gallery` exit with 1, and that the index links every page it is told of. The pages are
// text; nothing is rendered.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  countsAsFailure, galleryIndex, galleryPage, gallerySummary, mib, ms, readGallerySummary, type GalleryEntry, type GalleryInfo, type GallerySummary,
} from '../../../src/cli/gallery-page.ts';
import { conformanceParams } from '../../../src/cli/gallery.ts';
import type { RenderResult } from '../../../src/cli/result.ts';
import { colorize, combine, gen, node, soften } from '../graph-fixtures.ts';

const INFO: GalleryInfo = { res: 513, category: 'ref', device: { adapter: 'NVIDIA <GTX>', software: false, profile: 'max' } };

function rendered(type: string, outputs: readonly string[], more: Partial<RenderResult> = {}): RenderResult {
  const pictures = Object.fromEntries(outputs.map((name) => [name, { file: `nodes/${type}/${name}-513.png`, width: 1808, height: 512 }]));
  return {
    type, res: 513, status: 'ok', errors: [], wallMs: 3.456, gpuMs: 0.5, peakBytes: 3 * 2 ** 20, longestSliceMs: 0.25, longestSliceKernels: [],
    engineErrors: [], files: Object.values(pictures).map((picture) => picture.file), pictures, views: {}, inputs: [], ...more,
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
  { def: importer, result: failed('io/import', 'No file selected'), connected: null, conformance: null, given: [] },
  { def: colorize, result: rendered('ref/colorize', ['out'], { pictures: { out: { file: 'nodes/ref/colorize/out-513.png', width: 513, height: 513 } }, views: { out: { file: 'nodes/ref/colorize/out-513-3d.png', width: 768, height: 512 } } }), connected: null, conformance: 'not json {', given: [] },
  { def: gen, result: rendered('ref/gen', ['out']), connected: null, conformance: REPORT, given: [] },
  { def: twoOutputs, result: rendered('ref/select', ['out', 'flow'], { longestSliceMs: 812, longestSliceKernels: ['ref/select.pass'], gpuMs: null, engineErrors: ['Validation <error>'] }), connected: null, conformance: null, given: [] },
  { def: soften, result: failed('ref/soften', 'kernel "<script>alert(1)</script>" failed'), connected: null, conformance: null, given: [] },
];

const page = galleryPage(INFO, ENTRIES);
/** The article of one node. */
function article(type: string): string {
  const start = page.indexOf(`<article class="node`, page.indexOf(`id="${type.replace('/', '-')}"`) - 60);
  assert.ok(start >= 0, `the page has no article for ${type}`);
  return page.slice(start, page.indexOf('</article>', start));
}

test('the page of a category is one HTML document that names what was rendered and on what, and links the index', () => {
  assert.ok(page.startsWith('<!doctype html>\n<html lang="en">'));
  assert.ok(page.trimEnd().endsWith('</html>'));
  assert.match(page, /<title>Orogen node gallery: ref<\/title>/);
  assert.match(page, /<p class="quiet">5 nodes of the category ref at 513 × 513 · <span class="failed">2 not rendered<\/span> · NVIDIA &lt;GTX&gt; · profile max · <a href="index\.html">all categories<\/a><\/p>/);
  assert.equal(page.split('<article ').length - 1, 5);
  // Every node has a link at the top.
  for (const type of ['io/import', 'ref/colorize', 'ref/gen', 'ref/select', 'ref/soften']) assert.ok(page.includes(`<a href="#${type.replace('/', '-')}"`), type);
  assert.match(galleryPage({ ...INFO, device: { adapter: 'llvmpipe', software: true, profile: 'core' } }, ENTRIES.slice(2, 3)), /1 node of the category ref at 513 × 513 · llvmpipe \(a software adapter\) · profile core/);
});

test('a page carries what the index says of it, and the index links every page it is told of, in the order given', () => {
  // Two of the five failed; the importer's failure is the documented one and does not count.
  const summary = gallerySummary(INFO, ENTRIES);
  assert.deepEqual(summary, { category: 'ref', nodes: 5, failed: 1, res: 513, adapter: 'NVIDIA <GTX>', software: false, profile: 'max' });
  assert.deepEqual(readGallerySummary(page), summary, 'read back from the page, with the characters HTML escapes');
  assert.equal(readGallerySummary('<!doctype html><html><head><title>Something else</title></head></html>'), null);
  assert.equal(readGallerySummary('<meta name="orogen-gallery" content="{not json">'), null);
  assert.equal(readGallerySummary('<meta name="orogen-gallery" content="{&quot;category&quot;:&quot;../x&quot;,&quot;nodes&quot;:1,&quot;failed&quot;:0,&quot;res&quot;:513,&quot;adapter&quot;:&quot;a&quot;,&quot;software&quot;:false,&quot;profile&quot;:&quot;max&quot;}">'), null, 'a category is a word');
  assert.equal(readGallerySummary('<meta name="orogen-gallery" content="{&quot;category&quot;:&quot;ref&quot;,&quot;nodes&quot;:-1}">'), null);

  const filter: GallerySummary = { category: 'filter', nodes: 14, failed: 0, res: 513, adapter: 'llvmpipe', software: true, profile: 'core' };
  const one: GallerySummary = { category: 'generate', nodes: 1, failed: 0, res: 257, adapter: 'NVIDIA <GTX>', software: false, profile: 'max' };
  const index = galleryIndex([one, filter, summary]);
  assert.ok(index.startsWith('<!doctype html>\n<html lang="en">') && index.trimEnd().endsWith('</html>'));
  assert.match(index, /<title>Orogen node gallery<\/title>/);
  assert.match(index, /<p class="quiet">3 categories, 20 nodes\. Each page is as its category was last drawn\.<\/p>/);
  assert.deepEqual([...index.matchAll(/<a href="([a-z]+)\.html">([a-z]+)<\/a>/g)].map((found) => `${found[1]}:${found[2]}`), ['generate:generate', 'filter:filter', 'ref:ref']);
  assert.ok(index.includes('<li><a href="generate.html">generate</a><p>1 node at 257 × 257</p><p>NVIDIA &lt;GTX&gt; · profile max</p></li>'));
  assert.ok(index.includes('<li><a href="filter.html">filter</a><p>14 nodes at 513 × 513</p><p>llvmpipe (a software adapter) · profile core</p></li>'));
  assert.ok(index.includes('<li class="broken"><a href="ref.html">ref</a><p>5 nodes at 513 × 513 · <span class="failed">1 failed</span></p>'));
  assert.ok(!index.includes('<article'), 'the index holds no node');
  assert.equal(readGallerySummary(index), null, 'the index is no category page');

  const empty = galleryIndex([]);
  assert.match(empty, /<p class="quiet">0 categories, 0 nodes\./);
  assert.ok(empty.includes('<p>No category has been drawn into this folder.</p>'));
});

test('a node: title, type, description, keywords, flags, the pictures of its outputs and what was measured', () => {
  const select = article('ref/select');
  assert.ok(select.includes('<h3>Select (Reference)</h3><code class="type">ref/select</code>'));
  assert.ok(select.includes('<p class="description">Selects &lt;steep&gt; &amp; &quot;flat&quot; ground.</p>'));
  assert.ok(select.includes('<p class="keywords"><span>slope</span><span>mask</span></p>'));
  assert.ok(select.includes('<span class="flag marked">resolutionDependent</span>') && !select.includes('maskable'));
  // The picture is linked from the page's own folder, one below the output folder, and states its size.
  assert.ok(select.includes('<a href="../nodes/ref/select/out-513.png"><img src="../nodes/ref/select/out-513.png" width="1808" height="512" alt="out of ref/select" loading="lazy"></a>'));
  // The second output is on the page beside the first, with its name and what it carries.
  assert.ok(select.includes(
    '<div class="outputs"><div class="secondary"><a href="../nodes/ref/select/flow-513.png"><img src="../nodes/ref/select/flow-513.png" width="1808" height="512" alt="flow of ref/select" loading="lazy"></a>'
    + '<span><code>flow</code>: field, data</span></div></div></figure>',
  ));
  assert.ok(select.indexOf('out-513.png') < select.indexOf('<div class="outputs">'), 'after the first');
  assert.ok(!article('ref/gen').includes('class="outputs"'), 'a node with one output has no such row');
  assert.match(select, /out at 513 × 513: time 3\.46 ms · GPU time not measured · peak memory 3\.00 MiB · /);
  assert.match(select, /<span class="failed">longest slice 812 ms, above the hard ceiling of 500 ms \(ref\/select\.pass\)<\/span>/);
  assert.match(select, /<span class="failed">GPU error outside every scope: Validation &lt;error&gt;<\/span>/);

  const gallery = article('ref/gen');
  assert.match(gallery, /time 3\.46 ms · GPU 0\.50 ms · peak memory 3\.00 MiB · <span>longest slice 0\.25 ms<\/span>/);
  assert.ok(article('ref/soften').includes('<span class="flag">maskable</span>'));

  // A colour output shows its 3d view beside the colour picture.
  const colored = article('ref/colorize');
  assert.ok(colored.includes('<img src="../nodes/ref/colorize/out-513.png" width="513" height="513"'));
  assert.ok(colored.includes('<img src="../nodes/ref/colorize/out-513-3d.png" width="768" height="512" alt="out of ref/colorize over its terrain"'));
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
  assert.ok(imported.includes('The node reads a file and its defaults select none: this error is the documented one. Once the node\'s test file has written conformance/io/import.json into this output folder, the gallery draws the node with the file of its conformance call.'));
  assert.ok(!soft.includes('this error is the documented one'));
});

test('a node that reads a file is drawn with the parameters of its conformance call, which the page names', () => {
  const given = [{ name: 'file', value: 'tests/nodes/io/assets/<terrain>-193.png' }, { name: 'channel', value: '"red"' }];
  const drawn: GalleryEntry = { def: importer, result: rendered('io/import', ['out']), connected: null, conformance: REPORT, given };
  const text = galleryPage({ ...INFO, category: 'io' }, [drawn]);
  assert.ok(text.includes('<p class="quiet">Drawn with the parameters of its conformance call: <code>file</code> = tests/nodes/io/assets/&lt;terrain&gt;-193.png, <code>channel</code> = &quot;red&quot;.</p>'));
  assert.ok(text.includes('<img src="../nodes/io/import/out-513.png"'));
  assert.ok(!text.includes('this error is the documented one'));
  assert.ok(!article('ref/gen').includes('Drawn with the parameters'), 'a node drawn at its defaults says nothing of the kind');
  // Drawn the way the suite ran it, the node is held to rendering: a failure counts, and the page does not excuse it.
  const broke: GalleryEntry = { ...drawn, result: failed('io/import', 'Cannot decode the image') };
  assert.deepEqual([countsAsFailure(drawn), countsAsFailure(broke), countsAsFailure({ ...broke, given: [] })], [false, true, false]);
  assert.ok(!galleryPage({ ...INFO, category: 'io' }, [broke]).includes('this error is the documented one'));
});

test('the parameters of a conformance call are read from its report, and a file that is no such report gives none', () => {
  const report = JSON.stringify({ type: 'io/import', checks: {}, optOuts: [], params: { file: '/repo/tests/nodes/io/assets/terrain-193.png', channel: 'red', inMax: 0.5 } });
  assert.deepEqual(conformanceParams(report), [{ name: 'file', value: '/repo/tests/nodes/io/assets/terrain-193.png' }, { name: 'channel', value: 'red' }, { name: 'inMax', value: 0.5 }]);
  for (const text of [null, 'not json {', '[]', '{}', '{"params":null}', '{"params":[1,2]}', '{"params":"file"}', JSON.stringify({ params: {} }), REPORT]) assert.deepEqual(conformanceParams(text), [], String(text).slice(0, 20));
});

test('a data output says what black and white stand for, and that its scale is logarithmic where it is', () => {
  const flowing = rendered('ref/select', ['out', 'flow'], {
    pictures: {
      out: { file: 'nodes/ref/select/out-513.png', width: 1808, height: 512, tone: { lo: 0, hi: 0.125, log: false } },
      flow: { file: 'nodes/ref/select/flow-513.png', width: 1808, height: 512, tone: { lo: 0.0000042, hi: 0.042, log: true } },
    },
  });
  const text = galleryPage(INFO, [{ def: twoOutputs, result: flowing, connected: flowing, conformance: null, given: [] }]);
  assert.match(text, /<figcaption>out at 513 × 513, from 0 \(black\) to 0\.125 \(white\): time/);
  assert.ok(text.includes('<span><code>flow</code>: field, data, on a logarithmic scale from 0.0000042 (black) to 0.042 (white)</span>'));
  // The connected variant shows its second output too, and says the same of it.
  const second = text.slice(text.indexOf('<figure class="connected">'));
  assert.ok(second.includes('<figcaption>out with <code>weights</code> connected, from 0 (black) to 0.125 (white)</figcaption><div class="outputs"><div class="secondary">'));
  assert.ok(second.includes('alt="flow of ref/select with its optional inputs connected"'));
  // A colour among the secondary outputs brings its view over the terrain.
  const tinted = node({ type: 'ref/tinted', title: 'Tinted (Reference)', inputs: [{ name: 'in', type: 'field' }], outputs: [{ name: 'out', type: 'field' }, { name: 'color', type: 'color' }] });
  const both = rendered('ref/tinted', ['out'], {
    pictures: { out: { file: 'nodes/ref/tinted/out-513.png', width: 1808, height: 512 }, color: { file: 'nodes/ref/tinted/color-513.png', width: 513, height: 513 } },
    views: { color: { file: 'nodes/ref/tinted/color-513-3d.png', width: 768, height: 512 } },
  });
  const colored = galleryPage(INFO, [{ def: tinted, result: both, connected: null, conformance: null, given: [] }]);
  assert.ok(colored.includes('<img src="../nodes/ref/tinted/color-513.png" width="513" height="513" alt="color of ref/tinted" loading="lazy"></a><a href="../nodes/ref/tinted/color-513-3d.png">'));
  assert.ok(colored.includes('alt="color of ref/tinted, over its terrain"'));
});

test('gallery exits with 1 for a node that fails, unless the node reads a file its defaults do not select', () => {
  assert.deepEqual(ENTRIES.map(countsAsFailure), [false, false, false, false, true]);
  // An import node drawn at its defaults that fails for another reason still has a file parameter: the page shows the error, a person judges it.
  assert.equal(countsAsFailure({ def: importer, result: failed('io/import', 'Out of GPU memory'), connected: null, conformance: null, given: [] }), false);
  assert.equal(countsAsFailure({ def: gen, result: failed('ref/gen', 'No file selected'), connected: null, conformance: null, given: [] }), false, 'ref/gen of the fixtures has a file parameter');
  assert.equal(countsAsFailure({ def: colorize, result: { ...rendered('ref/colorize', []), status: 'errors' }, connected: null, conformance: null, given: [] }), true);
});

test('a node with a connected variant shows outputs[0] a second time, with its optional inputs and its mask connected', () => {
  const connected = rendered('ref/combine', ['out'], { pictures: { out: { file: 'nodes/ref/combine/out-513-connected.png', width: 1808, height: 512 } } });
  const entries: GalleryEntry[] = [
    { def: combine, result: rendered('ref/combine', ['out']), connected, conformance: null, given: [] },
    { def: soften, result: rendered('ref/soften', ['out']), connected: failed('ref/soften', 'The <mask> broke it'), conformance: null, given: [] },
    { def: gen, result: rendered('ref/gen', ['out']), connected: null, conformance: null, given: [] },
  ];
  const text = galleryPage(INFO, entries);
  const of = (type: string): string => text.slice(text.indexOf(`id="${type.replace('/', '-')}"`), text.indexOf('</article>', text.indexOf(`id="${type.replace('/', '-')}"`)));
  const both = of('ref/combine');
  assert.ok(both.includes('<img src="../nodes/ref/combine/out-513.png"'), 'the plain picture');
  assert.ok(both.includes('<figure class="connected"><a href="../nodes/ref/combine/out-513-connected.png"><img src="../nodes/ref/combine/out-513-connected.png" width="1808" height="512" alt="out of ref/combine with its optional inputs connected"'));
  assert.ok(both.includes('<figcaption>out with <code>mask</code> connected</figcaption>'));
  assert.ok(both.indexOf('out-513.png') < both.indexOf('out-513-connected.png'), 'after the plain one');
  // A node that fails only with its optional inputs connected is broken, and says how.
  const broken = of('ref/soften');
  assert.ok(text.includes('<article class="node broken" id="ref-soften">'));
  assert.ok(broken.includes('<img src="../nodes/ref/soften/out-513.png"'));
  assert.ok(broken.includes('<p>Not rendered with its optional inputs connected.</p><pre>ref/soften failed, node-exception: The &lt;mask&gt; broke it'));
  assert.ok(!of('ref/gen').includes('class="connected"'));
  // ref/gen of the fixtures has a file parameter, so its failures never count; the two others do.
  assert.deepEqual(entries.map(countsAsFailure), [false, true, false]);

  // An optional input that is no mask is named with the mask of a maskable node.
  const guided = node({
    type: 'filter/guided', title: 'Guided', category: 'filter', maskable: true,
    inputs: [{ name: 'in', type: 'any' }, { name: 'guide', type: 'field', optional: true }], outputs: [{ name: 'out', type: { sameAs: 'in' } }],
  });
  const page = galleryPage({ ...INFO, category: 'filter' }, [{ def: guided, result: rendered('filter/guided', ['out']), connected: rendered('filter/guided', ['out']), conformance: null, given: [] }]);
  assert.ok(page.includes('<figcaption>out with <code>guide</code>, <code>mask</code> connected</figcaption>'));
});

test('a node with two or more connected inputs shows what each was given, beside what it made of them', () => {
  const given = (suffix: string, ports: readonly (readonly [string, 'terrain' | 'mask' | 'color' | 'stamp' | 'flow' | 'snow'])[]) =>
    ports.map(([port, kind]) => ({ port, kind, file: `nodes/ref/combine/input-${port}-513${suffix}.png`, width: 513, height: 513 }));
  const entry: GalleryEntry = {
    def: combine,
    result: rendered('ref/combine', ['out'], { inputs: given('', [['a', 'terrain'], ['b', 'terrain']]) }),
    connected: rendered('ref/combine', ['out'], { inputs: given('-connected', [['a', 'terrain'], ['b', 'color'], ['mask', 'mask']]) }),
    conformance: null, given: [],
  };
  const text = galleryPage(INFO, [entry, { def: gen, result: rendered('ref/gen', ['out']), connected: null, conformance: null, given: [] }]);
  const of = (type: string): string => text.slice(text.indexOf(`id="${type.replace('/', '-')}"`), text.indexOf('</article>', text.indexOf(`id="${type.replace('/', '-')}"`)));
  const combined = of('ref/combine');
  // Before the picture of the output, in the order of the ports, each linked to its file and named.
  assert.ok(combined.includes(
    '<figure><div class="inputs">'
    + '<a class="given" href="../nodes/ref/combine/input-a-513.png"><img src="../nodes/ref/combine/input-a-513.png" width="513" height="513" alt="what the input a of ref/combine was given" loading="lazy"><span><code>a</code>: a terrain</span></a>'
    + '<a class="given" href="../nodes/ref/combine/input-b-513.png"><img src="../nodes/ref/combine/input-b-513.png" width="513" height="513" alt="what the input b of ref/combine was given" loading="lazy"><span><code>b</code>: a terrain</span></a>'
    + '</div><a href="../nodes/ref/combine/out-513.png">',
  ));
  const second = combined.slice(combined.indexOf('<figure class="connected">'));
  assert.deepEqual([...second.matchAll(/<span><code>([a-z]+)<\/code>: ([a-z ]+)<\/span>/g)].map((found) => `${found[1]}: ${found[2]}`), ['a: a terrain', 'b: a coloring', 'mask: the mask']);
  assert.ok(second.indexOf('input-mask-513-connected.png') < second.indexOf('out-513.png'), 'the inputs come first');
  // A node that was given one terrain, or none, shows no inputs.
  assert.ok(!of('ref/gen').includes('class="inputs"'));
  // An input the wiring knows by name says what it was given.
  const named = galleryPage(INFO, [{ ...entry, connected: null, result: rendered('ref/combine', ['out'], { inputs: given('', [['a', 'stamp'], ['b', 'flow'], ['mask', 'snow']]) }) }]);
  assert.deepEqual([...named.matchAll(/<span><code>([a-z]+)<\/code>: ([a-z ]+)<\/span>/g)].map((found) => `${found[1]}: ${found[2]}`), ['a: a landform', 'b: the drainage of the terrain', 'mask: the snow on the terrain']);
});

test('times and sizes are written for a person', () => {
  assert.deepEqual([ms(0.123), ms(3.456), ms(45.67), ms(812.4), ms(9999), ms(12_345)], ['0.12 ms', '3.46 ms', '45.7 ms', '812 ms', '9999 ms', '12.3 s']);
  assert.deepEqual([mib(0), mib(65_536), mib(3 * 2 ** 20), mib(250 * 2 ** 20), mib(3.5 * 2 ** 30)], ['0.00 MiB', '0.06 MiB', '3.00 MiB', '250 MiB', '3.50 GiB']);
});
