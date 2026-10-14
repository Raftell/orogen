// The pages of the user documentation, as the application carries them (runtime.md 8.8 rule 7): the Markdown of
// docs/user and its pictures, packed into the page by the build, so that Help shows them itself and depends on
// no program of the system. The files are read when the page is built: this module runs in the built page only,
// and no module a window-free test loads imports it.

const TEXTS = import.meta.glob<string>('../../../../docs/user/*.md', { query: '?raw', import: 'default', eager: true });
const PICTURES = import.meta.glob<string>('../../../../docs/user/images/*.png', { query: '?url', import: 'default', eager: true });

const nameOf = (file: string): string => file.slice(file.lastIndexOf('/') + 1);

/** The text of each page, by its name in docs/user: 'application.md'. */
export const HELP_TEXTS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(TEXTS).map(([file, text]) => [nameOf(file), text]));
/** The address of each picture, by its path from docs/user: 'images/application.png'. */
export const HELP_PICTURES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(PICTURES).map(([file, url]) => [`images/${nameOf(file)}`, url]));
