// gallery/index.html (testing.md 8.6): the page a reviewer reads. Pure: it makes the text of the page from
// what was rendered.

import type { NodeDef, ParamDef, PortDef } from '../core/api.ts';
import type { NodeError } from '../core/runtime.ts';
import { describeError, HARD_CEILING_MS, type RenderResult, type WrittenPicture } from './result.ts';

export interface GalleryEntry {
  readonly def: NodeDef;
  readonly result: RenderResult;
  /** The masked variant (testing.md 2.4), for a node that has one and rendered without it; else null. */
  readonly masked: RenderResult | null;
  /** The text of conformance/<category>/<name>.json in the output folder; null when it holds none. */
  readonly conformance: string | null;
}

export interface GalleryInfo {
  readonly res: number;
  readonly category: string | null;
  /** null: no node was rendered, so no device was opened. */
  readonly device: { readonly adapter: string; readonly software: boolean; readonly profile: string } | null;
}

/** A node whose defaults cannot run because it reads a file: listed with its error, and not what makes the gallery fail. */
const needsFile = (def: NodeDef): boolean => def.params.some((param) => param.kind === 'file');

/** Whether this entry makes `gallery` exit with 1. */
export function countsAsFailure(entry: GalleryEntry): boolean {
  return (entry.result.status !== 'ok' || (entry.masked !== null && entry.masked.status !== 'ok')) && !needsFile(entry.def);
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

function errorBox(def: NodeDef, result: RenderResult): string {
  const own = (error: NodeError): string => `<pre>${esc(describeError(error, false))}</pre>`;
  const lines = result.errors.map(own);
  if (lines.length === 0) lines.push(`<pre>${esc(`The evaluation ended with status "${result.status}".`)}</pre>`);
  const note = needsFile(def) ? '<p class="quiet">The node reads a file and its defaults select none: this error is the documented one.</p>' : '';
  return `<div class="failed"><p>Not rendered.</p>${lines.join('')}</div>${note}`;
}

/** A picture, linked to its file. The size is stated so that the page keeps its layout while pictures load. */
function image(picture: WrittenPicture, alt: string): string {
  const src = `../${esc(picture.file)}`;
  return `<a href="${src}"><img src="${src}" width="${picture.width}" height="${picture.height}" alt="${esc(alt)}" loading="lazy"></a>`;
}

/** The second figure of a node with a masked variant: outputs[0] with the optional mask inputs connected, or why there is none. */
function maskedFigure(def: NodeDef, masked: RenderResult | null, primary: string): string {
  if (masked === null) return '';
  const main = masked.pictures[primary];
  if (masked.status !== 'ok' || main === undefined) return `<div class="failed"><p>Not rendered with its mask connected.</p>${masked.errors.map((error) => `<pre>${esc(describeError(error, false))}</pre>`).join('')}</div>`;
  const view = masked.views[primary];
  const inputs = [...def.inputs.filter((port) => port.role === 'mask' && port.optional).map((port) => port.name), ...(def.maskable ? ['mask'] : [])];
  return `<figure class="masked">${image(main, `${primary} of ${def.type} under a mask`)}${view ? image(view, `${primary} of ${def.type} under a mask, over its height input`) : ''}`
    + `<figcaption>${esc(primary)} with ${inputs.map((name) => `<code>${esc(name)}</code>`).join(', ')} connected to a slope mask of the first terrain's broad shape</figcaption></figure>`;
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
    `<article class="node${result.status === 'ok' && (entry.masked === null || entry.masked.status === 'ok') ? '' : ' broken'}" id="${esc(anchor(def.type))}">`,
    `<header><h3>${esc(def.title)}</h3><code class="type">${esc(def.type)}</code>${flags}</header>`,
    `<p class="description">${esc(def.description)}</p>`,
    def.keywords && def.keywords.length > 0 ? `<p class="keywords">${def.keywords.map((word) => `<span>${esc(word)}</span>`).join('')}</p>` : '',
    main !== undefined
      ? `<figure>${image(main, `${primary} of ${def.type}`)}${view ? image(view, `${primary} of ${def.type} over its height input`) : ''}<figcaption>${esc(primary)} at ${res} × ${res}: ${measuredItems.join(' · ')}</figcaption></figure>`
      : errorBox(def, result),
    maskedFigure(def, entry.masked, primary),
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

/** gallery/index.html. Pictures are linked relative to the page, which lies one folder below the output folder. */
export function galleryPage(info: GalleryInfo, entries: readonly GalleryEntry[]): string {
  const categories = [...new Set(entries.map((entry) => entry.def.category))];
  const failed = entries.filter((entry) => entry.result.status !== 'ok');
  const summary = [
    `${entries.length} ${entries.length === 1 ? 'node' : 'nodes'}${info.category !== null ? ` of the category ${info.category}` : ''} at ${info.res} × ${info.res}`,
    ...(failed.length > 0 ? [`<span class="failed">${failed.length} not rendered</span>`] : []),
    ...(info.device ? [`${esc(info.device.adapter)}${info.device.software ? ' (a software adapter)' : ''}`, `profile ${esc(info.device.profile)}`] : []),
  ].join(' · ');
  const sections = categories.map((category) => [
    `<h2 id="${esc(category)}">${esc(category)}</h2>`,
    ...entries.filter((entry) => entry.def.category === category).map((entry) => nodeArticle(entry, info.res)),
  ].join('\n'));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orogen node gallery</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>Orogen node gallery</h1>
<p class="quiet">${summary}</p>
<nav>${entries.map((entry) => `<a href="#${esc(anchor(entry.def.type))}"${entry.result.status === 'ok' ? '' : ' class="failed"'}>${esc(entry.def.type)}</a>`).join('')}</nav>
</header>
<main>
${entries.length > 0 ? sections.join('\n') : '<p>The registry has no node with outputs in this selection.</p>'}
</main>
</body>
</html>
`;
}
