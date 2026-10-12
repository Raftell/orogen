// A WGSL token scan, enough for the checks defineKernel and defineLib make on author code (engine.md 3.2, 3.7).
// It is not a parser: it knows comments, identifiers, numbers and single punctuation characters.

export interface Token {
  /** An identifier or keyword, a number, or one punctuation character. */
  readonly text: string;
  readonly ident: boolean;
}

export interface Declaration {
  readonly keyword: 'fn' | 'struct' | 'const' | 'var' | 'alias' | 'override';
  readonly name: string;
  /** Index in the token list of the declared name. */
  readonly at: number;
}

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_PART = /[A-Za-z0-9_\u0080-￿]/;
const DIGIT = /[0-9]/;

/** The tokens of WGSL text. Comments (line comments and nested block comments) yield none. */
export function tokenize(code: string): Token[] {
  const out: Token[] = [];
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i]!;
    if (c === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++;
    } else if (c === '/' && code[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (code[i] === '/' && code[i + 1] === '*') { depth++; i += 2; }
        else if (code[i] === '*' && code[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
    } else if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(code[j]!)) j++;
      out.push({ text: code.slice(i, j), ident: true });
      i = j;
    } else if (DIGIT.test(c)) {
      // A number with its suffix and exponent (1.5e-3f, 0x1Fu): one token, so "2u" does not read as an identifier.
      let j = i + 1;
      while (j < n && (IDENT_PART.test(code[j]!) || code[j] === '.' || ((code[j] === '+' || code[j] === '-') && /[eEpP]/.test(code[j - 1]!)))) j++;
      out.push({ text: code.slice(i, j), ident: false });
      i = j;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      out.push({ text: c, ident: false });
      i++;
    }
  }
  return out;
}

const DECLARING: ReadonlySet<string> = new Set(['fn', 'struct', 'const', 'var', 'alias', 'override']);

/** Every name declared at module scope, in order. */
export function moduleDeclarations(tokens: readonly Token[]): Declaration[] {
  const out: Declaration[] = [];
  let braces = 0, parens = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.text === '{') braces++;
    else if (t.text === '}') braces--;
    else if (t.text === '(') parens++;
    else if (t.text === ')') parens--;
    else if (braces === 0 && parens === 0 && t.ident && DECLARING.has(t.text)) {
      let j = i + 1;
      if (t.text === 'var' && tokens[j]?.text === '<') {
        while (j < tokens.length && tokens[j]!.text !== '>') j++;
        j++;
      }
      const name = tokens[j];
      if (name?.ident) out.push({ keyword: t.text as Declaration['keyword'], name: name.text, at: j });
    }
  }
  return out;
}

/** True when the token at `at` and its successors spell `words`. */
export function follows(tokens: readonly Token[], at: number, words: readonly string[]): boolean {
  for (let k = 0; k < words.length; k++) {
    if (tokens[at + k]?.text !== words[k]) return false;
  }
  return true;
}

/** Index of the first occurrence of the token sequence, or -1. */
export function findSequence(tokens: readonly Token[], words: readonly string[], from = 0): number {
  for (let i = from; i + words.length <= tokens.length; i++) {
    if (follows(tokens, i, words)) return i;
  }
  return -1;
}
