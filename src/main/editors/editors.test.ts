import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectEditors,
  editorArgs,
  isRunnable,
  parseRegQuery,
} from './editors';

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const REG = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{771FD6B0}_is1
    DisplayName    REG_SZ    Microsoft Visual Studio Code (User)
    InstallLocation    REG_SZ    INSTALL\\
    DisplayIcon    REG_SZ    "INSTALL\\Code.exe",0

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other
    DisplayName    REG_SZ    Something Else
`;

describe('editor detection', () => {
  it('reads uninstall entries from reg query output', () => {
    expect(parseRegQuery(REG)).toEqual([
      {
        displayName: 'Microsoft Visual Studio Code (User)',
        installLocation: 'INSTALL\\',
        displayIcon: '"INSTALL\\Code.exe",0',
      },
      {
        displayName: 'Something Else',
        installLocation: null,
        displayIcon: null,
      },
    ]);
  });

  it.skipIf(process.platform !== 'win32')(
    'finds an editor on Windows only when its .exe really exists',
    async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'gitdesk-editors-'));
      const install = path.join(dir, 'VS Code');
      mkdirSync(install);
      const registry = REG.replaceAll('INSTALL', install);
      const none = await detectEditors('win32', {}, async () => registry);
      expect(none).toEqual([]);
      writeFileSync(path.join(install, 'Code.exe'), '');
      const found = await detectEditors('win32', {}, async (key) =>
        key.startsWith('HKCU') ? registry : '',
      );
      expect(found).toMatchObject([
        { id: 'vscode', exe: path.join(install, 'Code.exe'), viaOpen: false },
      ]);
    },
  );
});

describe('editor launch arguments', () => {
  const target = { folder: '/repo', file: '/repo/src/a.ts', line: 12 };
  const on = { gotoLine: true, openFolder: true };

  it('builds each family its own way, always with absolute paths', () => {
    expect(editorArgs('vscode', target, on)).toEqual([
      '/repo',
      '--goto',
      '/repo/src/a.ts:12',
    ]);
    expect(editorArgs('jetbrains', target, on)).toEqual([
      '/repo',
      '--line',
      '12',
      '/repo/src/a.ts',
    ]);
    expect(editorArgs('notepadpp', target, on)).toEqual([
      '-n12',
      '/repo/src/a.ts',
    ]);
    expect(editorArgs('zed', { ...target, file: null }, on)).toEqual(['/repo']);
    expect(
      editorArgs('sublime', target, { gotoLine: false, openFolder: false }),
    ).toEqual(['/repo/src/a.ts']);
  });

  it('never hands a runnable file to the system default app', () => {
    for (const file of ['setup.exe', 'run.BAT', 'x.ps1', 'tool.lnk', 'a.py'])
      expect(isRunnable(file)).toBe(true);
    for (const file of ['README.md', 'src/app.tsx', 'notes.txt'])
      expect(isRunnable(file)).toBe(false);
  });
});
