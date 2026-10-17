import { safeParseJSON } from './json';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

// Encrypts and decrypts one string. In the app this is Electron's safeStorage,
// whose key lives in the macOS Keychain; tests pass a stand-in.
export type SecretBox = {
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
};

// The file exists but can't be read back: damaged, or encrypted with a
// Keychain key this Mac no longer has. Callers must not overwrite it.
export class VaultUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultUnreadableError';
  }
}

const envelopeSchema = z.object({ version: z.literal(1), data: z.string() });

// One JSON document, encrypted as a whole so nothing (not even site names)
// sits on disk in the clear. Writes are atomic and the file is owner-only.
export class EncryptedJsonFile<T> {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: {
      file: string;
      box: SecretBox;
      schema: z.ZodType<T>;
      empty: () => T;
    },
  ) {}

  async read(): Promise<T> {
    let raw: string;
    try {
      raw = await readFile(this.options.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.options.empty();
      }
      throw error;
    }

    const envelope = await safeParseJSON({ text: raw, schema: envelopeSchema });
    if (!envelope.success) {
      throw new VaultUnreadableError(
        'The saved file is damaged, so ploop left it alone.',
      );
    }

    let plain: string;
    try {
      plain = this.options.box.decrypt(
        Buffer.from(envelope.value.data, 'base64'),
      );
    } catch {
      throw new VaultUnreadableError(
        'ploop could not unlock the saved file. It was probably encrypted by a different Mac or Keychain, so ploop left it alone.',
      );
    }

    const parsed = await safeParseJSON({
      text: plain,
      schema: this.options.schema,
    });
    if (!parsed.success) {
      throw new VaultUnreadableError(
        'The saved file has an unexpected format, so ploop left it alone.',
      );
    }
    return parsed.value;
  }

  private async write(value: T) {
    const data = this.options.box
      .encrypt(JSON.stringify(value))
      .toString('base64');
    const target = this.options.file;
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, data }), { mode: 0o600 });
    await rename(tmp, target);
  }

  // Read, change, write, one caller at a time, so two quick edits never
  // overwrite each other.
  update<R>(fn: (value: T) => { value: T; result: R }): Promise<R> {
    const run = async () => {
      const { value, result } = fn(await this.read());
      await this.write(value);
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }
}
