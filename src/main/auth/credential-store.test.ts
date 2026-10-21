import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore } from './credential-store';

type Storage = ConstructorParameters<typeof CredentialStore>[1];

// Reversible stand-in for safeStorage: a fixed prefix plus the reversed UTF-8 bytes.
const PREFIX = Buffer.from('enc:');
const encrypt = (s: string) =>
  Buffer.concat([PREFIX, Buffer.from(s).reverse()]);
function decrypt(buf: Buffer): string {
  if (!buf.subarray(0, PREFIX.length).equals(PREFIX))
    throw new Error('bad ciphertext');
  return Buffer.from(buf.subarray(PREFIX.length)).reverse().toString();
}

function fakeStorage(overrides: Partial<Record<keyof Storage, unknown>> = {}) {
  return {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (s: string) => encrypt(s)),
    decryptStringAsync: vi.fn(async (buf: Buffer) => ({
      result: decrypt(buf),
      shouldReEncrypt: false,
    })),
    ...overrides,
  } as unknown as Storage & Record<keyof Storage, ReturnType<typeof vi.fn>>;
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'gitdesk-cred-'));
  file = path.join(dir, 'refresh-token.bin');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('CredentialStore', () => {
  it('keeps the token in memory on Linux with the basic_text backend', async () => {
    const storage = fakeStorage({
      getSelectedStorageBackend: vi.fn(() => 'basic_text'),
    });
    const store = new CredentialStore(file, storage, 'linux');

    expect(await store.persistence()).toBe('memory');
    await store.save('refresh-1');

    expect(existsSync(file)).toBe(false);
    expect(storage.encryptStringAsync).not.toHaveBeenCalled();
    expect(await store.load()).toBe('refresh-1');
    // A fresh instance (next app launch) has nothing to restore.
    expect(await new CredentialStore(file, storage, 'linux').load()).toBeNull();
  });

  it('uses memory when async encryption is unavailable', async () => {
    const storage = fakeStorage({
      isAsyncEncryptionAvailable: vi.fn(async () => false),
    });
    const store = new CredentialStore(file, storage, 'win32');

    expect(await store.persistence()).toBe('memory');
    await store.save('refresh-1');
    expect(existsSync(file)).toBe(false);
  });

  it('writes encrypted bytes with the secure backend and round-trips them', async () => {
    const storage = fakeStorage();
    const store = new CredentialStore(file, storage, 'linux');

    expect(await store.persistence()).toBe('secure');
    await store.save('refresh-1');

    const onDisk = await readFile(file);
    expect(onDisk.equals(encrypt('refresh-1'))).toBe(true);
    expect(onDisk.toString()).not.toContain('refresh-1');

    // A fresh instance has no memory copy, so this reads and decrypts the file.
    const reloaded = new CredentialStore(file, storage, 'linux');
    expect(await reloaded.load()).toBe('refresh-1');
    expect(storage.decryptStringAsync).toHaveBeenCalledOnce();
  });

  it('returns null when there is no file', async () => {
    expect(
      await new CredentialStore(file, fakeStorage(), 'darwin').load(),
    ).toBeNull();
  });

  it('clears the file when it cannot be decrypted', async () => {
    await writeFile(file, 'garbage');
    const storage = fakeStorage({
      decryptStringAsync: vi.fn(async () => {
        throw new Error('key changed');
      }),
    });
    const store = new CredentialStore(file, storage, 'win32');

    expect(await store.load()).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('rewrites the file when shouldReEncrypt is set', async () => {
    await writeFile(file, encrypt('refresh-1'));
    const storage = fakeStorage({
      decryptStringAsync: vi.fn(async (buf: Buffer) => ({
        result: decrypt(buf),
        shouldReEncrypt: true,
      })),
      // The re-encrypted form differs from what was on disk.
      encryptStringAsync: vi.fn(async (s: string) =>
        Buffer.concat([encrypt(s), Buffer.from('#v2')]),
      ),
    });
    const store = new CredentialStore(file, storage, 'darwin');

    expect(await store.load()).toBe('refresh-1');
    expect(storage.encryptStringAsync).toHaveBeenCalledWith('refresh-1');
    const onDisk = await readFile(file);
    expect(
      onDisk.equals(Buffer.concat([encrypt('refresh-1'), Buffer.from('#v2')])),
    ).toBe(true);
  });

  it('clear removes both the memory copy and the file', async () => {
    const storage = fakeStorage();
    const store = new CredentialStore(file, storage, 'win32');
    await store.save('refresh-1');

    await store.clear();

    expect(existsSync(file)).toBe(false);
    expect(await store.load()).toBeNull();
  });
});
