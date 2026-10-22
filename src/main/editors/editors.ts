import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EditorId } from '../../shared/settings';
import type { DetectedEditor } from '../../shared/workspace';

type Family = 'vscode' | 'zed' | 'sublime' | 'notepadpp' | 'jetbrains';

type Candidate = {
  id: DetectedEditor['id'];
  name: string;
  family: Family;
  // Windows: uninstall entries whose DisplayName starts with one of these (and not `exclude`).
  windows?: {
    prefixes: string[];
    exclude?: string;
    // Executables relative to InstallLocation; without them DisplayIcon names the program.
    exe?: string[];
    // Common install folders, for installs that left no uninstall entry.
    known?: string[];
  };
  mac?: { app: string; cli?: string };
  linux?: string[];
};

const jetbrains = (
  id: DetectedEditor['id'],
  name: string,
  win: { prefixes: string[]; exclude?: string; bin: string },
  mac: string,
  linux: string[],
): Candidate => ({
  id,
  name,
  family: 'jetbrains',
  windows: {
    prefixes: win.prefixes,
    exclude: win.exclude,
    exe: [`bin\\${win.bin}64.exe`, `bin\\${win.bin}.exe`],
  },
  mac: { app: `${mac}.app`, cli: `Contents/MacOS/${win.bin}` },
  linux: [
    ...linux.map((name) => `/snap/bin/${name}`),
    `~/.local/share/JetBrains/Toolbox/scripts/${win.bin}`,
  ],
});

const CANDIDATES: Candidate[] = [
  {
    id: 'vscode',
    name: 'Visual Studio Code',
    family: 'vscode',
    windows: {
      prefixes: ['Microsoft Visual Studio Code'],
      exclude: 'Insiders',
      exe: ['Code.exe'],
      known: [
        '%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe',
        '%ProgramFiles%\\Microsoft VS Code\\Code.exe',
      ],
    },
    mac: {
      app: 'Visual Studio Code.app',
      cli: 'Contents/Resources/app/bin/code',
    },
    linux: [
      '/usr/bin/code',
      '/snap/bin/code',
      '/var/lib/flatpak/exports/bin/com.visualstudio.code',
      '~/.local/share/flatpak/exports/bin/com.visualstudio.code',
    ],
  },
  {
    id: 'vscode-insiders',
    name: 'VS Code Insiders',
    family: 'vscode',
    windows: {
      prefixes: ['Microsoft Visual Studio Code Insiders'],
      exe: ['Code - Insiders.exe'],
      known: [
        '%LOCALAPPDATA%\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe',
      ],
    },
    mac: {
      app: 'Visual Studio Code - Insiders.app',
      cli: 'Contents/Resources/app/bin/code',
    },
    linux: ['/usr/bin/code-insiders', '/snap/bin/code-insiders'],
  },
  {
    id: 'vscodium',
    name: 'VSCodium',
    family: 'vscode',
    windows: {
      prefixes: ['VSCodium'],
      exe: ['VSCodium.exe'],
      known: ['%LOCALAPPDATA%\\Programs\\VSCodium\\VSCodium.exe'],
    },
    mac: { app: 'VSCodium.app', cli: 'Contents/Resources/app/bin/codium' },
    linux: [
      '/usr/bin/codium',
      '/snap/bin/codium',
      '/var/lib/flatpak/exports/bin/com.vscodium.codium',
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    family: 'vscode',
    windows: {
      prefixes: ['Cursor'],
      known: ['%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe'],
    },
    mac: { app: 'Cursor.app', cli: 'Contents/Resources/app/bin/cursor' },
    linux: ['/usr/bin/cursor', '~/.local/bin/cursor'],
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    family: 'vscode',
    windows: {
      prefixes: ['Windsurf'],
      known: ['%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe'],
    },
    mac: { app: 'Windsurf.app', cli: 'Contents/Resources/app/bin/windsurf' },
    linux: ['/usr/bin/windsurf'],
  },
  {
    id: 'zed',
    name: 'Zed',
    family: 'zed',
    windows: {
      prefixes: ['Zed'],
      known: ['%LOCALAPPDATA%\\Programs\\Zed\\Zed.exe'],
    },
    mac: { app: 'Zed.app', cli: 'Contents/MacOS/cli' },
    linux: ['/usr/bin/zed', '~/.local/bin/zed'],
  },
  {
    id: 'sublime',
    name: 'Sublime Text',
    family: 'sublime',
    windows: {
      prefixes: ['Sublime Text'],
      exe: ['subl.exe', 'sublime_text.exe'],
      known: [
        '%ProgramFiles%\\Sublime Text\\subl.exe',
        '%ProgramFiles%\\Sublime Text 3\\subl.exe',
      ],
    },
    mac: { app: 'Sublime Text.app', cli: 'Contents/SharedSupport/bin/subl' },
    linux: [
      '/usr/bin/subl',
      '/snap/bin/subl',
      '/opt/sublime_text/sublime_text',
    ],
  },
  {
    id: 'notepadpp',
    name: 'Notepad++',
    family: 'notepadpp',
    windows: {
      prefixes: ['Notepad++'],
      exe: ['notepad++.exe'],
      known: [
        '%ProgramFiles%\\Notepad++\\notepad++.exe',
        '%ProgramFiles(x86)%\\Notepad++\\notepad++.exe',
      ],
    },
  },
  jetbrains(
    'webstorm',
    'WebStorm',
    { prefixes: ['WebStorm'], bin: 'webstorm' },
    'WebStorm',
    ['webstorm'],
  ),
  jetbrains(
    'intellij',
    'IntelliJ IDEA',
    {
      prefixes: ['IntelliJ IDEA'],
      exclude: 'Community',
      bin: 'idea',
    },
    'IntelliJ IDEA',
    ['intellij-idea-ultimate'],
  ),
  jetbrains(
    'intellij-ce',
    'IntelliJ IDEA Community',
    { prefixes: ['IntelliJ IDEA Community'], bin: 'idea' },
    'IntelliJ IDEA CE',
    ['intellij-idea-community'],
  ),
  jetbrains(
    'pycharm',
    'PyCharm',
    { prefixes: ['PyCharm'], exclude: 'Community', bin: 'pycharm' },
    'PyCharm',
    ['pycharm-professional'],
  ),
  jetbrains(
    'pycharm-ce',
    'PyCharm Community',
    { prefixes: ['PyCharm Community'], bin: 'pycharm' },
    'PyCharm CE',
    ['pycharm-community'],
  ),
  jetbrains(
    'phpstorm',
    'PhpStorm',
    { prefixes: ['PhpStorm'], bin: 'phpstorm' },
    'PhpStorm',
    ['phpstorm'],
  ),
  jetbrains(
    'goland',
    'GoLand',
    { prefixes: ['GoLand'], bin: 'goland' },
    'GoLand',
    ['goland'],
  ),
  jetbrains(
    'rider',
    'Rider',
    { prefixes: ['JetBrains Rider'], bin: 'rider' },
    'Rider',
    ['rider'],
  ),
  jetbrains('clion', 'CLion', { prefixes: ['CLion'], bin: 'clion' }, 'CLion', [
    'clion',
  ]),
  jetbrains(
    'rubymine',
    'RubyMine',
    { prefixes: ['RubyMine'], bin: 'rubymine' },
    'RubyMine',
    ['rubymine'],
  ),
  jetbrains(
    'rustrover',
    'RustRover',
    { prefixes: ['RustRover'], bin: 'rustrover' },
    'RustRover',
    ['rustrover'],
  ),
];

export const EDITOR_CHECKED_FOR =
  'Visual Studio Code, VS Code Insiders, VSCodium, Cursor, Windsurf, Zed, Sublime Text, Notepad++ and JetBrains IDEs';

export type UninstallEntry = {
  displayName: string;
  installLocation: string | null;
  displayIcon: string | null;
};

// `reg query <Uninstall key> /s` prints one block per subkey: the key line, then
// "    Name    REG_SZ    Value" lines. Only the three values detection needs are kept.
export function parseRegQuery(output: string): UninstallEntry[] {
  const entries: UninstallEntry[] = [];
  let current: UninstallEntry | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) {
      if (current?.displayName) entries.push(current);
      current = { displayName: '', installLocation: null, displayIcon: null };
      continue;
    }
    const match =
      /^\s+(DisplayName|InstallLocation|DisplayIcon)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(
        line,
      );
    if (!match || !current) continue;
    const value = match[2]!.trim();
    if (match[1] === 'DisplayName') current.displayName = value;
    else if (match[1] === 'InstallLocation')
      current.installLocation = value || null;
    else current.displayIcon = value || null;
  }
  if (current?.displayName) entries.push(current);
  return entries;
}

const UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

function regQuery(key: string): Promise<string> {
  return new Promise((resolve) =>
    execFile(
      'reg',
      ['query', key, '/s'],
      { timeout: 10_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? '' : stdout),
    ),
  );
}

const expand = (template: string, env: NodeJS.ProcessEnv): string =>
  template
    .replace(/%([^%]+)%/g, (_m, name: string) => env[name] ?? '')
    .replace(/^~(?=\/|$)/, os.homedir());

// Only an absolute, existing .exe is ever accepted on Windows: a .cmd or .bat would need a shell.
const usableWindowsExe = (file: string | null): string | null =>
  file &&
  path.isAbsolute(file) &&
  file.toLowerCase().endsWith('.exe') &&
  existsSync(file)
    ? file
    : null;

export type FoundEditor = DetectedEditor & {
  family: Family;
  // The program main starts. On macOS without a CLI it is the .app, opened with `open -a`.
  exe: string;
  viaOpen: boolean;
};

export async function detectEditors(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  readRegistry: (key: string) => Promise<string> = regQuery,
): Promise<FoundEditor[]> {
  const found: FoundEditor[] = [];
  if (platform === 'win32') {
    const entries = (
      await Promise.all(UNINSTALL_KEYS.map((key) => readRegistry(key)))
    ).flatMap(parseRegQuery);
    for (const candidate of CANDIDATES) {
      const win = candidate.windows;
      if (!win) continue;
      let exe: string | null = null;
      for (const entry of entries) {
        if (
          !win.prefixes.some((prefix) =>
            entry.displayName.startsWith(prefix),
          ) ||
          (win.exclude && entry.displayName.includes(win.exclude))
        )
          continue;
        const fromLocation = entry.installLocation
          ? (win.exe ?? []).map((rel) =>
              path.join(entry.installLocation!.replace(/^"|"$/g, ''), rel),
            )
          : [];
        const fromIcon = entry.displayIcon
          ? [entry.displayIcon.replace(/^"|"$/g, '').replace(/,-?\d+$/, '')]
          : [];
        exe =
          [...fromLocation, ...fromIcon].map(usableWindowsExe).find(Boolean) ??
          null;
        if (exe) break;
      }
      exe ??=
        (win.known ?? [])
          .map((known) => usableWindowsExe(expand(known, env)))
          .find(Boolean) ?? null;
      if (exe)
        found.push({
          id: candidate.id,
          name: candidate.name,
          family: candidate.family,
          location: exe,
          exe,
          viaOpen: false,
        });
    }
    return found;
  }
  if (platform === 'darwin') {
    for (const candidate of CANDIDATES) {
      if (!candidate.mac) continue;
      const app = ['/Applications', path.join(os.homedir(), 'Applications')]
        .map((dir) => path.join(dir, candidate.mac!.app))
        .find((file) => existsSync(file));
      if (!app) continue;
      const cli = candidate.mac.cli ? path.join(app, candidate.mac.cli) : null;
      const useCli = !!cli && existsSync(cli);
      found.push({
        id: candidate.id,
        name: candidate.name,
        family: candidate.family,
        location: app,
        exe: useCli ? cli! : app,
        viaOpen: !useCli,
      });
    }
    return found;
  }
  for (const candidate of CANDIDATES) {
    const exe = (candidate.linux ?? [])
      .map((file) => expand(file, env))
      .find((file) => path.isAbsolute(file) && existsSync(file));
    if (exe)
      found.push({
        id: candidate.id,
        name: candidate.name,
        family: candidate.family,
        location: exe,
        exe,
        viaOpen: false,
      });
  }
  return found;
}

// Arguments for one editor family. Every path is absolute, so none can be read as an option.
export function editorArgs(
  family: Family,
  target: { folder: string; file: string | null; line: number | null },
  options: { gotoLine: boolean; openFolder: boolean },
): string[] {
  const { folder, file } = target;
  if (!file) return [folder];
  const line = options.gotoLine ? target.line : null;
  const withFolder = options.openFolder && family !== 'notepadpp';
  const lead = withFolder ? [folder] : [];
  switch (family) {
    case 'vscode':
      return line ? [...lead, '--goto', `${file}:${line}`] : [...lead, file];
    case 'zed':
    case 'sublime':
      return [...lead, line ? `${file}:${line}` : file];
    case 'notepadpp':
      return line ? [`-n${line}`, file] : [file];
    case 'jetbrains':
      return line ? [...lead, '--line', String(line), file] : [...lead, file];
  }
}

// Detached and shell-free: the editor outlives gitdesk, and nothing is parsed by a shell.
export function launchEditor(
  editor: FoundEditor,
  args: string[],
  onError: (err: Error) => void,
): void {
  const [command, argv] = editor.viaOpen
    ? ['open', ['-a', editor.exe, ...args]]
    : [editor.exe, args];
  const child = spawn(command, argv, {
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: false,
  });
  child.on('error', onError);
  child.unref();
}

// Opening one of these with the system default app would run it, so it is shown in its folder.
const RUNNABLE =
  /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|hta|cpl|lnk|url|reg|jar|app|command|sh|bash|zsh|py|pyw|pl|rb|appimage|desktop|dmg|pkg|deb|rpm|apk|scf|inf|pif|msc|ws|application|gadget|settingcontent-ms)$/i;
export const isRunnable = (file: string): boolean => RUNNABLE.test(file);

export const editorName = (id: EditorId): string =>
  id === 'system'
    ? 'System default app'
    : (CANDIDATES.find((c) => c.id === id)?.name ?? id);
