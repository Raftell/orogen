// gallery/<category>.html and gallery/index.html (testing.md 8.6): the pages a reviewer reads. Pure: it makes
// the text of a page from what was rendered.

import type { NodeDef, ParamDef, PortDef } from '../core/api.ts';
import type { NodeError } from '../core/runtime.ts';
import { describeError, HARD_CEILING_MS, type RenderResult, type WrittenInput, type WrittenPicture } from './result.ts';

export interface GalleryEntry {
  readonly def: NodeDef;
  readonly result: RenderResult;
  /** The connected variant (testing.md 2.4), for a node that has one and rendered without it; else null. */
  readonly connected: RenderResult | null;
  /** The text of conformance/<category>/<name>.json in the output folder; null when it holds none. */
  readonly conformance: string | null;
  /**
   * The parameters the node was drawn with beside its defaults, as the page says them: those of its conformance
   * call, for a node with a file parameter whose report the output folder holds. Empty: drawn at its defaults.
   */
  readonly given: readonly { readonly name: string; readonly value: string }[];
}

export interface GalleryInfo {
  readonly res: number;
  /** The category of the page: every entry is of it. */
  readonly category: string;
  readonly device: { readonly adapter: string; readonly software: boolean; readonly profile: string };
}

/** What the index says of one category page. A page carries it, so that the index can list pages of earlier runs. */
export interface GallerySummary {
  readonly category: string;
  readonly nodes: number;
  /** Nodes that failed and count for the exit code. */
  readonly failed: number;
  readonly res: number;
  readonly adapter: string;
  readonly software: boolean;
  readonly profile: string;
}

/** A node whose defaults cannot run because it reads a file. */
export const needsFile = (def: NodeDef): boolean => def.params.some((param) => param.kind === 'file');

/**
 * Whether this entry makes `gallery` exit with 1. A node that reads a file and was drawn at its defaults, which
 * select none, is listed with its error and is no failure; drawn with the file of its conformance call it is
 * held to rendering like any other.
 */
export function countsAsFailure(entry: GalleryEntry): boolean {
  const excused = needsFile(entry.def) && entry.given.length === 0;
  return (entry.result.status !== 'ok' || (entry.connected !== null && entry.connected.status !== 'ok')) && !excused;
}

const esc = (text: unknown): string => String(text)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const capital = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);
const num = (value: number): string => (Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6))));
const anchor = (type: string): string => type.replace('/', '-');

export function ms(value: number): string {
  if (value >= 10_000) return `${(value / 1000).toFixed(1)} s`;
  return `${value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0)} ms`;
}

export function mib(bytes: number): string {
  const value = bytes / 2 ** 20;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} GiB`;
  return `${value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0)} MiB`;
}

/** A linear colour as the sRGB colour a browser shows. */
function swatch(color: readonly number[]): string {
  const hex = color.slice(0, 3).map((linear) => {
    const c = Math.min(1, Math.max(0, Number.isFinite(linear) ? linear : 0));
    const encoded = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255).toString(16).padStart(2, '0');
  }).join('');
  return `<span class="swatch" style="background:#${hex}"></span>`;
}

function portType(port: PortDef): string {
  if (typeof port.type === 'object') return `same as ${port.type.sameAs}`;
  return port.type === 'field' ? `field, ${port.role ?? 'height'}` : port.type;
}

function defaultOf(param: ParamDef): string {
  switch (param.kind) {
    case 'float': case 'int': case 'seed': return esc(num(param.default));
    case 'bool': return param.default ? 'on' : 'off';
    case 'enum': return esc(param.options.find((option) => option.value === param.default)?.label ?? param.default);
    case 'vec2': return esc(`[${param.default.map(num).join(', ')}]`);
    case 'color': return `${swatch(param.default)} ${esc(`[${param.default.map(num).join(', ')}]`)}`;
    case 'curve': return esc(param.default.map((point) => `(${num(point.x)}, ${num(point.y)})`).join(' '));
    case 'gradient': return param.default.map((stop) => `${swatch(stop.color)} ${esc(num(stop.t))}`).join(' ');
    case 'file': return 'no file';
    case 'text': return param.default === '' ? 'empty' : esc(JSON.stringify(param.default));
  }
}

function rangeOf(param: ParamDef): string {
  switch (param.kind) {
    case 'float': return esc(`${num(param.min)} .. ${num(param.max)}${param.soft ? ', soft' : ''}${param.scale === 'log' ? ', log' : ''}`);
    case 'int': return esc(`${num(param.min)} .. ${num(param.max)}`);
    case 'vec2': return esc(`${num(param.min)} .. ${num(param.max)}${param.soft ? ', soft' : ''}`);
    case 'enum': return esc(param.options.map((option) => option.label).join(', '));
    case 'seed': return '0 .. 4294967295';
    case 'color': return '0 .. 1';
    case 'file': return esc(param.filters.map((filter) => `*.${filter}`).join(', '));
    case 'text': return esc(`at most ${param.maxLength ?? 256} characters`);
    case 'bool': case 'curve': case 'gradient': return '';
  }
}

const unitOf = (param: ParamDef): string => (param.kind === 'float' || param.kind === 'vec2' ? param.unit : '');

function portRows(side: 'input' | 'output', ports: readonly PortDef[], pictures: Readonly<Record<string, WrittenPicture>>): string {
  return ports.map((port) => {
    const picture = side === 'output' ? pictures[port.name] : undefined;
    const name = picture !== undefined ? `<a href="../${esc(picture.file)}">${esc(port.name)}</a>` : esc(port.name);
    return `<tr><td>${side}</td><td><code>${name}</code></td><td>${esc(port.label ?? capital(port.name))}</td><td>${esc(portType(port))}${port.optional ? ', optional' : ''}</td></tr>`;
  }).join('\n');
}

function paramRows(params: readonly ParamDef[]): string {
  return params.map((param) => [
    '<tr>',
    `<td>${esc(param.label ?? capital(param.name))}</td>`,
    `<td><code>${esc(param.name)}</code></td>`,
    `<td>${esc(param.kind)}</td>`,
    `<td>${esc(unitOf(param))}</td>`,
    `<td>${defaultOf(param)}</td>`,
    `<td>${rangeOf(param)}</td>`,
    `<td>${esc(param.help)}</td>`,
    '</tr>',
  ].join('')).join('\n');
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The report of testing.md 3.6 rule 2: what it says in a few lines, then the file's content as it is. */
function conformanceSection(def: NodeDef, text: string | null): string {
  if (text === null) return '<p class="quiet">No conformance report in this output folder: the node\'s test file writes it.</p>';
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    report = null;
  }
  const parts: string[] = [];
  if (isRecord(report)) {
    const adapter = isRecord(report.adapter) ? String(report.adapter.description || report.adapter.device || '') : '';
    if (adapter !== '' || typeof report.profile === 'string') {
      parts.push(`<p class="quiet">Checked on ${esc(adapter || 'an unnamed adapter')}${typeof report.profile === 'string' ? `, profile ${esc(report.profile)}` : ''}.</p>`);
    }
    if (isRecord(report.checks)) {
      const items = Object.entries(report.checks).map(([name, check]) => {
        const result = isRecord(check) && typeof check.result === 'string' ? check.result : 'unknown';
        const reason = isRecord(check) && typeof check.reason === 'string' ? ` title="${esc(check.reason)}"` : '';
        return `<li class="check ${esc(result.replace(/[^a-z-]/g, ''))}"${reason}>${esc(name)}: ${esc(result)}</li>`;
      });
      parts.push(`<ul class="checks">${items.join('')}</ul>`);
    }
    if (Array.isArray(report.optOuts) && report.optOuts.length > 0) {
      const items = report.optOuts.filter(isRecord).map((optOut) => {
        const what = optOut.kind === 'tolerance' ? `tolerance ${esc(optOut.value)}` : 'skipped';
        return `<li><strong>${esc(optOut.check)}</strong> ${what}: ${esc(optOut.reason)}</li>`;
      });
      parts.push(`<p>Opt-outs for the reviewer to approve:</p><ul class="optouts">${items.join('')}</ul>`);
    } else if (Array.isArray(report.optOuts)) parts.push('<p class="quiet">No opt-outs.</p>');
    if (isRecord(report.budget) && typeof report.budget.estimateBytes === 'number') {
      parts.push(`<p>Budget: ${esc((report.budget.estimateBytes / 1e9).toFixed(2))} GB at 8129, ${report.budget.asserted === true ? 'asserted' : 'not asserted on that device'}.</p>`);
    }
  } else parts.push('<p class="failed">The report is not JSON.</p>');
  parts.push(`<details><summary>conformance/${esc(def.type)}.json</summary><pre>${esc(text)}</pre></details>`);
  return parts.join('\n');
}

function errorBox(entry: GalleryEntry): string {
  const { def, result } = entry;
  const own = (error: NodeError): string => `<pre>${esc(describeError(error, false))}</pre>`;
  const lines = result.errors.map(own);
  if (lines.length === 0) lines.push(`<pre>${esc(`The evaluation ended with status "${result.status}".`)}</pre>`);
  const note = needsFile(def) && entry.given.length === 0
    ? `<p class="quiet">The node reads a file and its defaults select none: this error is the documented one. Once the node's test file has written conformance/${esc(def.type)}.json into this output folder, the gallery draws the node with the file of its conformance call.</p>`
    : '';
  return `<div class="failed"><p>Not rendered.</p>${lines.join('')}</div>${note}`;
}

/** A picture, linked to its file. The size is stated so that the page keeps its layout while pictures load. */
function image(picture: WrittenPicture, alt: string): string {
  const src = `../${esc(picture.file)}`;
  return `<a href="${src}"><img src="${src}" width="${picture.width}" height="${picture.height}" alt="${esc(alt)}" loading="lazy"></a>`;
}

const GIVEN: Readonly<Record<WrittenInput['kind'], string>> = {
  terrain: 'a terrain', mask: 'the mask', color: 'a coloring',
  stamp: 'a landform', flow: 'the drainage of the terrain', snow: 'the snow on the terrain',
};

/** What black and white stand for in the picture of a data output. */
function scaleNote(tone: WrittenPicture['tone']): string {
  if (!tone) return '';
  return `, ${tone.log ? 'on a logarithmic scale from' : 'from'} ${esc(num(tone.lo))} (black) to ${esc(num(tone.hi))} (white)`;
}

/**
 * The outputs after the first, beside it: each with its picture, and a colour with its view over the terrain.
 * A secondary output is part of what a node makes, and a reviewer who has to follow a link to see it does not.
 */
function secondaryRow(def: NodeDef, result: RenderResult, variant: string): string {
  const items = def.outputs.slice(1).flatMap((port) => {
    const picture = result.pictures[port.name];
    if (picture === undefined) return [];
    const view = result.views[port.name];
    const alt = `${port.name} of ${def.type}${variant}`;
    return [`<div class="secondary">${image(picture, alt)}${view ? image(view, `${alt}, over its terrain`) : ''}<span><code>${esc(port.name)}</code>: ${esc(portType(port))}${scaleNote(picture.tone)}</span></div>`];
  });
  return items.length > 0 ? `<div class="outputs">${items.join('')}</div>` : '';
}

/** What the node was given, beside what it made of it: one small picture per connected input, where there are two or more. */
function givenRow(type: string, inputs: readonly WrittenInput[]): string {
  if (inputs.length === 0) return '';
  const items = inputs.map((input) => {
    const src = `../${esc(input.file)}`;
    return `<a class="given" href="${src}"><img src="${src}" width="${input.width}" height="${input.height}" alt="${esc(`what the input ${input.port} of ${type} was given`)}" loading="lazy">`
      + `<span><code>${esc(input.port)}</code>: ${GIVEN[input.kind]}</span></a>`;
  });
  return `<div class="inputs">${items.join('')}</div>`;
}

/** The second figure of a node with a connected variant: outputs[0] with the optional inputs and the mask connected, or why there is none. */
function connectedFigure(def: NodeDef, connected: RenderResult | null, primary: string): string {
  if (connected === null) return '';
  const main = connected.pictures[primary];
  if (connected.status !== 'ok' || main === undefined) return `<div class="failed"><p>Not rendered with its optional inputs connected.</p>${connected.errors.map((error) => `<pre>${esc(describeError(error, false))}</pre>`).join('')}</div>`;
  const view = connected.views[primary];
  const inputs = [...def.inputs.filter((port) => port.optional).map((port) => port.name), ...(def.maskable ? ['mask'] : [])];
  return `<figure class="connected">${givenRow(def.type, connected.inputs)}${image(main, `${primary} of ${def.type} with its optional inputs connected`)}${view ? image(view, `${primary} of ${def.type} with its optional inputs connected, over its terrain`) : ''}`
    + `<figcaption>${esc(primary)} with ${inputs.map((name) => `<code>${esc(name)}</code>`).join(', ')} connected${scaleNote(main.tone)}</figcaption>`
    + `${secondaryRow(def, connected, ' with its optional inputs connected')}</figure>`;
}

function nodeArticle(entry: GalleryEntry, res: number): string {
  const { def, result } = entry;
  const primary = def.outputs[0]?.name ?? '';
  const main = result.pictures[primary];
  const view = result.views[primary];
  const flags = [
    def.maskable ? '<span class="flag">maskable</span>' : '',
    def.resolutionDependent ? '<span class="flag marked">resolutionDependent</span>' : '',
  ].join('');
  const overran = result.longestSliceMs > HARD_CEILING_MS;
  const measuredItems = result.status === 'ok' ? [
    `time ${ms(result.wallMs)}`,
    result.gpuMs === null ? 'GPU time not measured' : `GPU ${ms(result.gpuMs)}`,
    `peak memory ${mib(result.peakBytes)}`,
    `<span${overran ? ' class="failed"' : ''}>longest slice ${ms(result.longestSliceMs)}${overran ? `, above the hard ceiling of ${HARD_CEILING_MS} ms (${esc(result.longestSliceKernels.join(', '))})` : ''}</span>`,
    ...result.engineErrors.map((message) => `<span class="failed">GPU error outside every scope: ${esc(message)}</span>`),
  ] : [];
  return [
    `<article class="node${result.status === 'ok' && (entry.connected === null || entry.connected.status === 'ok') ? '' : ' broken'}" id="${esc(anchor(def.type))}">`,
    `<header><h3>${esc(def.title)}</h3><code class="type">${esc(def.type)}</code>${flags}</header>`,
    `<p class="description">${esc(def.description)}</p>`,
    def.keywords && def.keywords.length > 0 ? `<p class="keywords">${def.keywords.map((word) => `<span>${esc(word)}</span>`).join('')}</p>` : '',
    entry.given.length > 0
      ? `<p class="quiet">Drawn with the parameters of its conformance call: ${entry.given.map((param) => `<code>${esc(param.name)}</code> = ${esc(param.value)}`).join(', ')}.</p>`
      : '',
    main !== undefined
      ? `<figure>${givenRow(def.type, result.inputs)}${image(main, `${primary} of ${def.type}`)}${view ? image(view, `${primary} of ${def.type} over its terrain`) : ''}`
        + `<figcaption>${esc(primary)} at ${res} × ${res}${scaleNote(main.tone)}: ${measuredItems.join(' · ')}</figcaption>${secondaryRow(def, result, '')}</figure>`
      : errorBox(entry),
    connectedFigure(def, entry.connected, primary),
    '<h4>Ports</h4>',
    `<table><thead><tr><th></th><th>Name</th><th>Label</th><th>Type</th></tr></thead><tbody>\n${portRows('input', def.inputs, {})}\n${portRows('output', def.outputs, result.pictures)}\n</tbody></table>`,
    '<h4>Parameters</h4>',
    def.params.length > 0
      ? `<table><thead><tr><th>Label</th><th>Name</th><th>Kind</th><th>Unit</th><th>Default</th><th>Range</th><th>Help</th></tr></thead><tbody>\n${paramRows(def.params)}\n</tbody></table>`
      : '<p class="quiet">None.</p>',
    '<h4>Conformance</h4>',
    conformanceSection(def, entry.conformance),
    '</article>',
  ].filter((line) => line !== '').join('\n');
}

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f5f2; --panel: #ffffff; --ink: #1d1d1b; --quiet: #6b6a66; --line: #d9d6cf; --bad: #b3261e; --mark: #8a5a00; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --panel: #1f1f1d; --ink: #e9e7e1; --quiet: #9b9992; --line: #36352f; --bad: #ff8a80; --mark: #e0b25a; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, sans-serif; }
main, body > header { max-width: 1240px; margin: 0 auto; }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--quiet); margin: 40px 0 12px; }
h3 { font-size: 20px; margin: 0; }
h4 { font-size: 13px; margin: 20px 0 6px; color: var(--quiet); }
nav { margin: 12px 0 0; display: flex; flex-wrap: wrap; gap: 4px 14px; }
a { color: inherit; }
code, pre { font: 13px/1.45 ui-monospace, monospace; }
.node { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 20px; margin: 0 0 20px; }
.node.broken { border-color: var(--bad); }
.node > header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
.type, .quiet, figcaption { color: var(--quiet); }
.flag { font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; }
.flag.marked { border-color: var(--mark); color: var(--mark); }
.description { margin: 8px 0 0; }
.keywords { margin: 6px 0 0; display: flex; flex-wrap: wrap; gap: 6px; font-size: 12px; color: var(--quiet); }
.keywords span { border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; }
figure { margin: 16px 0 0; display: flex; flex-wrap: wrap; gap: 8px; }
figure a { max-width: 100%; }
figcaption { flex-basis: 100%; }
.inputs { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 8px; }
.given { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--quiet); text-decoration: none; }
.given img { width: 168px; height: 168px; }
.outputs { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.secondary { flex: 1 1 520px; max-width: 904px; display: flex; flex-wrap: wrap; gap: 2px 8px; font-size: 12px; color: var(--quiet); }
.secondary a { flex: 1 1 0; min-width: 0; }
.secondary span { flex-basis: 100%; }
.pages { list-style: none; padding: 0; margin: 24px 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.pages li { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
.pages li.broken { border-color: var(--bad); }
.pages a { font-size: 18px; font-weight: 600; }
.pages p { margin: 4px 0 0; font-size: 13px; color: var(--quiet); }
img { display: block; max-width: 100%; height: auto; border-radius: 4px; background: #1a1a1a; }
figcaption { font-size: 13px; margin-top: 6px; }
.failed { color: var(--bad); }
div.failed { margin: 16px 0 0; }
div.failed pre { white-space: pre-wrap; margin: 4px 0; }
table { border-collapse: collapse; width: 100%; font-size: 13px; display: block; overflow-x: auto; }
th, td { text-align: left; vertical-align: top; padding: 4px 12px 4px 0; border-bottom: 1px solid var(--line); }
th { color: var(--quiet); font-weight: 500; }
.swatch { display: inline-block; width: 12px; height: 12px; border: 1px solid var(--line); border-radius: 2px; vertical-align: -1px; }
.checks { list-style: none; padding: 0; margin: 6px 0; display: flex; flex-wrap: wrap; gap: 4px 6px; font-size: 12px; }
.check { border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; }
.check.failed { border-color: var(--bad); }
.check.skipped { border-color: var(--mark); color: var(--mark); }
.check.not-applicable { color: var(--quiet); }
.optouts { margin: 4px 0; padding-left: 20px; }
details pre { overflow-x: auto; padding: 12px; border: 1px solid var(--line); border-radius: 4px; }
`;

const SUMMARY_META = 'orogen-gallery';

/** What the index says of the page of `entries`. */
export function gallerySummary(info: GalleryInfo, entries: readonly GalleryEntry[]): GallerySummary {
  return {
    category: info.category, nodes: entries.length, failed: entries.filter(countsAsFailure).length, res: info.res,
    adapter: info.device.adapter, software: info.device.software, profile: info.device.profile,
  };
}

/** The summary a category page carries; null when the text is no such page. */
export function readGallerySummary(html: string): GallerySummary | null {
  const found = new RegExp(`<meta name="${SUMMARY_META}" content="([^"]*)">`).exec(html);
  if (!found) return null;
  let value: unknown;
  try {
    value = JSON.parse(found[1]!.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { category, nodes, failed, res, adapter, software, profile } = value;
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  if (typeof category !== 'string' || !/^[a-z]+$/.test(category) || !count(nodes) || !count(failed) || !count(res)) return null;
  if (typeof adapter !== 'string' || typeof software !== 'boolean' || typeof profile !== 'string') return null;
  return { category, nodes, failed, res, adapter, software, profile };
}

const page = (title: string, head: string, header: string, main: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${head}<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
${header}
</header>
<main>
${main}
</main>
</body>
</html>
`;

const drawnOn = (summary: Pick<GallerySummary, 'adapter' | 'software' | 'profile'>): string =>
  `${esc(summary.adapter)}${summary.software ? ' (a software adapter)' : ''} · profile ${esc(summary.profile)}`;

/**
 * gallery/<category>.html: the nodes of one category. Pictures are linked relative to the page, which lies one
 * folder below the output folder.
 */
export function galleryPage(info: GalleryInfo, entries: readonly GalleryEntry[]): string {
  const failed = entries.filter((entry) => entry.result.status !== 'ok');
  const summary = [
    `${entries.length} ${entries.length === 1 ? 'node' : 'nodes'} of the category ${esc(info.category)} at ${info.res} × ${info.res}`,
    ...(failed.length > 0 ? [`<span class="failed">${failed.length} not rendered</span>`] : []),
    drawnOn(info.device),
  ].join(' · ');
  return page(
    `Orogen node gallery: ${info.category}`,
    `<meta name="${SUMMARY_META}" content="${esc(JSON.stringify(gallerySummary(info, entries)))}">\n`,
    [
      `<h1>Orogen node gallery: ${esc(info.category)}</h1>`,
      `<p class="quiet">${summary} · <a href="index.html">all categories</a></p>`,
      `<nav>${entries.map((entry) => `<a href="#${esc(anchor(entry.def.type))}"${entry.result.status === 'ok' ? '' : ' class="failed"'}>${esc(entry.def.type)}</a>`).join('')}</nav>`,
    ].join('\n'),
    entries.map((entry) => nodeArticle(entry, info.res)).join('\n'),
  );
}

/** gallery/index.html: a link to the page of every category that has been drawn into the folder, in the order given. */
export function galleryIndex(pages: readonly GallerySummary[]): string {
  const nodes = pages.reduce((sum, summary) => sum + summary.nodes, 0);
  const items = pages.map((summary) => [
    `<li${summary.failed > 0 ? ' class="broken"' : ''}><a href="${esc(summary.category)}.html">${esc(summary.category)}</a>`,
    `<p>${summary.nodes} ${summary.nodes === 1 ? 'node' : 'nodes'} at ${summary.res} × ${summary.res}${summary.failed > 0 ? ` · <span class="failed">${summary.failed} failed</span>` : ''}</p>`,
    `<p>${drawnOn(summary)}</p></li>`,
  ].join(''));
  return page(
    'Orogen node gallery',
    '',
    `<h1>Orogen node gallery</h1>\n<p class="quiet">${pages.length} ${pages.length === 1 ? 'category' : 'categories'}, ${nodes} ${nodes === 1 ? 'node' : 'nodes'}. Each page is as its category was last drawn.</p>`,
    pages.length > 0 ? `<ul class="pages">\n${items.join('\n')}\n</ul>` : '<p>No category has been drawn into this folder.</p>',
  );
}
