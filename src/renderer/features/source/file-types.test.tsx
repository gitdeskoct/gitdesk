import { renderToStaticMarkup } from 'react-dom/server';
import { bundledLanguagesInfo } from 'shiki/langs';
import { describe, expect, it } from 'vitest';
import {
  BY_EXTENSION,
  BY_NAME,
  fileType,
  folderIcon,
  LANGUAGE_LABELS,
} from '../../../shared/file-types';
import { FILE_ICONS, FOLDER_ICONS, iconFor } from './file-icons';

const shikiIds = new Set(
  bundledLanguagesInfo.flatMap((l) => [l.id, ...(l.aliases ?? [])]),
);

describe('file types', () => {
  it('maps every language to a grammar Shiki ships, with a label', () => {
    const used = [...Object.values(BY_EXTENSION), ...Object.values(BY_NAME)]
      .map((rule) => rule.lang)
      .filter((lang): lang is string => !!lang);
    for (const lang of new Set(used)) {
      expect(shikiIds.has(lang), lang).toBe(true);
      expect(LANGUAGE_LABELS[lang], lang).toBeTruthy();
    }
    for (const lang of Object.keys(LANGUAGE_LABELS))
      expect(shikiIds.has(lang), lang).toBe(true);
  });

  it('prefers an exact name, then a pattern, then a compound extension, then the extension', () => {
    expect(fileType('package-lock.json')).toMatchObject({
      icon: 'lock',
      lang: 'json',
    });
    expect(fileType('data/package.json')).toMatchObject({
      icon: 'json',
      lang: 'json',
    });
    expect(fileType('tsconfig.app.json')).toMatchObject({
      icon: 'config',
      lang: 'jsonc',
    });
    expect(fileType('vite.main.config.mts')).toMatchObject({
      icon: 'config',
      lang: 'typescript',
    });
    expect(fileType('src/a.test.ts')).toMatchObject({
      icon: 'test',
      lang: 'typescript',
    });
    expect(fileType('src/__tests__/a.ts').icon).toBe('test');
    expect(fileType('types/env.d.ts')).toMatchObject({
      icon: 'code',
      label: 'TypeScript declarations',
    });
    expect(fileType('dist/app.min.js')).toMatchObject({
      icon: 'code',
      lang: 'javascript',
    });
    expect(fileType('backup.tar.gz').icon).toBe('archive');
    expect(fileType('Dockerfile.prod')).toMatchObject({
      icon: 'container',
      lang: 'docker',
    });
    expect(fileType('docker-compose.dev.yml')).toMatchObject({
      icon: 'container',
      lang: 'yaml',
    });
    expect(fileType('.env.local')).toMatchObject({
      icon: 'key',
      lang: 'dotenv',
    });
    expect(fileType('LICENSE-MIT').icon).toBe('license');
    expect(fileType('CHANGELOG.md')).toMatchObject({
      icon: 'changelog',
      lang: 'markdown',
    });
    expect(fileType('README')).toMatchObject({ icon: 'doc', lang: 'markdown' });
    expect(fileType('.vscode/settings.json')).toMatchObject({ lang: 'jsonc' });
  });

  it('matches names in any case and falls back to a plain file', () => {
    expect(fileType('MAKEFILE')).toMatchObject({
      icon: 'config',
      lang: 'make',
    });
    expect(fileType('Logo.PNG')).toMatchObject({ icon: 'image', lang: null });
    expect(fileType('notes.unknownext')).toEqual({
      icon: 'file',
      lang: null,
      label: 'UNKNOWNEXT file',
    });
    expect(fileType('noextension')).toEqual({
      icon: 'file',
      lang: null,
      label: 'File',
    });
  });

  it('gives well-known folders their own icon', () => {
    expect(folderIcon('src')).toBe('src');
    expect(folderIcon('.GITHUB')).toBe('git');
    expect(folderIcon('node_modules')).toBe('deps');
    expect(folderIcon('lib')).toBe('folder');
  });

  it('draws every kind with a real Lucide icon, no two kinds alike', () => {
    const drawn = Object.values(FILE_ICONS).map((Icon) => {
      expect(Icon).toBeTruthy();
      return renderToStaticMarkup(<Icon />).replace(/class="[^"]*"/, '');
    });
    expect(new Set(drawn).size).toBe(drawn.length);
    for (const Icon of Object.values(FOLDER_ICONS)) expect(Icon).toBeTruthy();
  });

  it('uses plain glyphs when file type icons are off', () => {
    const plain = iconFor(
      { name: 'a.ts', path: 'a.ts', type: 'file' },
      false,
      false,
    );
    expect(plain).toBe(
      iconFor({ name: 'x.png', path: 'x.png', type: 'file' }, false, false),
    );
    expect(
      iconFor({ name: 'a.ts', path: 'a.ts', type: 'file' }, false, true),
    ).toBe(FILE_ICONS.code);
  });
});
