// Writes src/app/panels/build/model/guide-text.ts from docs/user/unreal-import.md: the text of the import guide
// the build panel opens. Not a test file. Run it when the document has changed (unit/guide.test.ts fails then):
//
//   tools/guard node tests/ui/build/make-guide.ts

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { GUIDE_DOCUMENT, readGuide, ROOT } from './unit/_guide.ts';

const TARGET = 'src/app/panels/build/model/guide-text.ts';

const guide = readGuide();
const literal = (value: unknown): string => JSON.stringify(value, null, 2);

writeFileSync(path.join(ROOT, TARGET), `// The text of the import guide: the legend and sections 1 to 4 of ${GUIDE_DOCUMENT}, word for word.
// Written by tests/ui/build/make-guide.ts; do not edit it by hand. tests/ui/build/unit/guide.test.ts fails when
// the document says something else.

import type { GuideSection } from './guide.ts';

export const GUIDE_DOCUMENT = ${literal(GUIDE_DOCUMENT)};

/** How far a statement about Unreal has been checked, and how far the procedure has been run. */
export const GUIDE_LEGEND: { readonly lead: string; readonly marks: readonly string[]; readonly warning: string } = ${literal(guide.legend)};

export const GUIDE_SECTIONS: readonly GuideSection[] = ${literal(guide.sections)};
`);
console.log(`${TARGET}: ${guide.sections.map((section) => `${section.number}. ${section.title} (${section.items.length})`).join(', ')}`);
