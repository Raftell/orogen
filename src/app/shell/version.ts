// The version of the application, as package.json states it. The page has no other way to it: the bridge does
// not carry it, and the build defines no constant. The file is read when the page is built, so this module runs
// in the built page only; a module that a window-free test loads does not import it.

const PACKAGE = import.meta.glob<string>('../../../package.json', { query: '?raw', import: 'default', eager: true });

function read(): { readonly version: string; readonly description: string } {
  const text = Object.values(PACKAGE)[0];
  try {
    const held = JSON.parse(text ?? '{}') as { readonly version?: unknown; readonly description?: unknown };
    return {
      version: typeof held.version === 'string' && held.version !== '' ? held.version : 'unknown',
      description: typeof held.description === 'string' ? held.description : '',
    };
  } catch {
    return { version: 'unknown', description: '' };
  }
}

export const APPLICATION: { readonly version: string; readonly description: string } = read();
