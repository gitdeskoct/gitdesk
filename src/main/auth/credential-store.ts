import { readFile, rm, writeFile } from 'node:fs/promises';
import type { SafeStorage } from 'electron';

type Storage = Pick<
  SafeStorage,
  | 'isAsyncEncryptionAvailable'
  | 'encryptStringAsync'
  | 'decryptStringAsync'
  | 'getSelectedStorageBackend'
>;

// Holds the refresh token. On Linux without a keyring safeStorage falls back to a hardcoded
// key, which is no protection, so the token then stays in memory and is never written.
export class CredentialStore {
  private memory: string | null = null;

  constructor(
    private readonly file: string,
    private readonly storage: Storage,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async persistence(): Promise<'secure' | 'memory'> {
    if (
      this.platform === 'linux' &&
      this.storage.getSelectedStorageBackend() === 'basic_text'
    ) {
      return 'memory';
    }
    return (await this.storage.isAsyncEncryptionAvailable())
      ? 'secure'
      : 'memory';
  }

  async save(token: string): Promise<void> {
    this.memory = token;
    if ((await this.persistence()) === 'secure') {
      await writeFile(this.file, await this.storage.encryptStringAsync(token), {
        mode: 0o600,
      });
    } else {
      await rm(this.file, { force: true });
    }
  }

  async load(): Promise<string | null> {
    if (this.memory) return this.memory;
    if ((await this.persistence()) !== 'secure') return null;
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.file);
    } catch {
      return null;
    }
    try {
      const { result, shouldReEncrypt } =
        await this.storage.decryptStringAsync(encrypted);
      if (shouldReEncrypt) await this.save(result);
      this.memory = result;
      return result;
    } catch {
      // Unreadable (key changed, file corrupted): drop it and sign in again.
      await this.clear();
      return null;
    }
  }

  async clear(): Promise<void> {
    this.memory = null;
    await rm(this.file, { force: true });
  }
}
