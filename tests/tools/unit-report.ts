// A reporter for `node --test`, beside the one a person reads: one JSON line for every test case that ended,
// with the file it is in and, for a failed one, what it said. `verify` (testing.md 5.3 step 2) runs the unit
// layer with it and reads from the lines whose every failure is: the category's own, or another owner's.
//
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//        --test-reporter=<this file as a URL> --test-reporter-destination=<file> "<patterns>"

import path from 'node:path';

/** One line of the report. `file` is relative to the working directory, with `/`. */
export interface UnitCase {
  readonly result: 'pass' | 'fail';
  readonly name: string;
  readonly file: string;
  /** A failed case: the first lines of its error. */
  readonly message?: string;
}

interface TestEvent {
  readonly type: string;
  readonly data: {
    readonly name?: string; readonly file?: string;
    readonly details?: { readonly type?: string; readonly error?: unknown };
  };
}

/** How much of an error is kept: enough to name the files and nodes it is about. */
const MESSAGE_CHARS = 4000;

/** The message of the error a failed test carries: that of its cause, which is what the test threw. */
function messageOf(error: unknown): string {
  const cause = typeof error === 'object' && error !== null && 'cause' in error && error.cause !== undefined ? error.cause : error;
  const text = typeof cause === 'object' && cause !== null && 'message' in cause ? String(cause.message) : String(cause);
  return text.slice(0, MESSAGE_CHARS);
}

export default async function* unitReport(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { name, file, details } = event.data;
    // A suite ends as its cases do; the cases are what is counted.
    if (details?.type === 'suite' || typeof name !== 'string') continue;
    const line: UnitCase = {
      result: event.type === 'test:pass' ? 'pass' : 'fail', name,
      file: typeof file === 'string' ? path.relative(process.cwd(), file).split(path.sep).join('/') : '',
      ...(event.type === 'test:fail' ? { message: messageOf(details?.error) } : {}),
    };
    yield `${JSON.stringify(line)}\n`;
  }
}
