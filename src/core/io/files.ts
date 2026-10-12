export class FileError extends Error {
  override name = 'FileError';
  readonly path: string;
  readonly code: 'not-found' | 'denied' | 'invalid-path' | 'io';

  constructor(code: 'not-found' | 'denied' | 'invalid-path' | 'io', path: string, message: string) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

export interface FileSource {
  /** The absolute path. A relative path is taken from the folder of the project file. */
  resolve(path: string): string;
  /** null when there is no such file. */
  stat(path: string): Promise<{ readonly size: number; readonly mtimeMs: number } | null>;
  read(path: string, range?: { readonly offset: number; readonly length: number }): Promise<Uint8Array<ArrayBuffer>>;
  /** Calls onChange after the file changed. Returns a function that stops watching. */
  watch?(path: string, onChange: () => void): () => void;
}

export interface FileWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<{ readonly bytes: number }>;
  abort(): Promise<void>;
}

export interface FileSink {
  /** Opens a file for streaming. */
  create(relPath: string): Promise<FileWriter>;
  /** Writes a whole small file: create, write, close. For files under 16 MiB. A string is written as UTF-8. */
  write(relPath: string, data: Uint8Array | string): Promise<void>;
  /** Aborts every writer that is open. */
  abortAll(): Promise<void>;
}
