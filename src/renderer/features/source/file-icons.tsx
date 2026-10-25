import {
  Database,
  File,
  FileArchive,
  FileAudio,
  FileBadge,
  FileBox,
  FileBraces,
  FileCheck,
  FileClock,
  FileCode,
  FileCog,
  FileDiff,
  FileDigit,
  FileImage,
  FileKey,
  FileLock,
  FileSliders,
  FileSpreadsheet,
  FileSymlink,
  FileTerminal,
  FileText,
  FileType,
  FileUser,
  FileVideo,
  Folder,
  FolderArchive,
  FolderCheck,
  FolderCode,
  FolderCog,
  FolderGit,
  FolderGit2,
  FolderOpen,
  type LucideIcon,
} from 'lucide-react';
import {
  fileType,
  folderIcon,
  type FileIcon,
  type FolderIcon,
} from '../../../shared/file-types';
import type { SourceEntryType } from '../../../shared/source';

// One Lucide glyph per kind, all in the muted ink: in gitdesk color means state, so a file's type
// shows in the shape of its icon and in the row's tooltip, never in a hue.
export const FILE_ICONS: Record<FileIcon, LucideIcon> = {
  code: FileCode,
  test: FileCheck,
  json: FileBraces,
  data: FileSliders,
  config: FileCog,
  lock: FileLock,
  key: FileKey,
  script: FileTerminal,
  container: FileBox,
  doc: FileText,
  license: FileBadge,
  changelog: FileClock,
  owners: FileUser,
  patch: FileDiff,
  sheet: FileSpreadsheet,
  database: Database,
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  archive: FileArchive,
  font: FileType,
  binary: FileDigit,
  file: File,
};

export const FOLDER_ICONS: Record<FolderIcon, LucideIcon> = {
  folder: Folder,
  src: FolderCode,
  tests: FolderCheck,
  settings: FolderCog,
  git: FolderGit,
  deps: FolderArchive,
};

// `typed` is Settings › Files › File type icons; off, every file and folder gets the plain glyph.
export function iconFor(
  entry: { name: string; path: string; type: SourceEntryType },
  open: boolean,
  typed: boolean,
): LucideIcon {
  if (entry.type === 'submodule') return FolderGit2;
  if (entry.type === 'dir') {
    if (open) return FolderOpen;
    return typed ? FOLDER_ICONS[folderIcon(entry.name)] : Folder;
  }
  if (entry.type === 'symlink') return typed ? FileSymlink : File;
  return typed ? FILE_ICONS[fileType(entry.path).icon] : File;
}
