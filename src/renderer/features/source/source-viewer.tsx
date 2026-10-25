import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowLeft, Download, FolderOpen, Info, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fileType } from '../../../shared/file-types';
import type {
  RemoteProblem,
  SourceEntry,
  SourceFile,
} from '../../../shared/source';
import {
  FileArt,
  FolderMissingArt,
  LinkArt,
  OfflineArt,
  RepositoriesArt,
} from '../../components/illustrations';
import { Avatar } from '../../components/ui/avatar';
import { Button } from '../../components/ui/button';
import { CopyButton } from '../../components/ui/copy-button';
import { EmptyState } from '../../components/ui/empty-state';
import { Loading } from '../../components/ui/status';
import { cn } from '../../lib/cn';
import { formatBytes, relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useSettings } from '../../lib/queries';
import { fileManagerLabel } from '../repos/repo-actions';
import { OpenInEditorButton } from '../repository/editor-button';
import {
  HIGHLIGHT_LIMIT,
  useLineTokens,
  type CodeToken,
} from '../repository/highlight';
import type { Fetched } from './source-queries';
import { STATUS_LABEL } from './source-tree';

const VIRTUALIZE_FROM = 400;

// What a remote problem means for the person, in one title and one sentence.
export const PROBLEM_TEXT: Record<
  RemoteProblem,
  { title: string; body: string }
> = {
  'signed-out': {
    title: 'Sign in to see these files',
    body: 'Files of a hosted repository load through your gitdesk account.',
  },
  'local-only': {
    title: 'gitdesk is working without an account',
    body: 'Hosted files need an account. Turn on the account in Settings, General.',
  },
  'hosting-off': {
    title: 'Git hosting is off on the server',
    body: 'Hosted files load once the gitdesk server turns hosting on. A local copy still works.',
  },
  'not-found': {
    title: 'This repository is gone',
    body: 'It isn’t in your account anymore, or it was never shared with it.',
  },
  'not-ready': {
    title: 'This repository is still being set up',
    body: 'Its Git storage isn’t ready yet. Try again in a moment.',
  },
  'ref-gone': {
    title: 'That branch or commit is gone',
    body: 'It was deleted on the server after you opened it.',
  },
  'path-gone': {
    title: 'Not in this commit',
    body: 'The folder or file was added or moved in another commit.',
  },
  offline: {
    title: 'gitdesk can’t reach the server',
    body: 'Check your connection. Nothing you opened before is lost.',
  },
  'rate-limited': {
    title: 'Too many requests for a moment',
    body: 'The server asked gitdesk to slow down. Try again in a minute.',
  },
  failed: {
    title: 'The server couldn’t read that',
    body: 'Try again. If it keeps failing, the details are in the logs.',
  },
};

// The lines of a file as shown: a final newline ends the last line instead of adding an empty one.
export const linesOf = (text: string): string[] =>
  (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');

function CodeView({
  text,
  path,
  line,
}: {
  text: string;
  path: string;
  line: number | null;
}) {
  const { data: settings } = useSettings();
  const lines = useMemo(() => linesOf(text), [text]);
  const body = useMemo(() => lines.join('\n'), [lines]);
  const wrap = settings?.sourceWrap ?? false;
  const numbers = settings?.sourceLineNumbers ?? true;
  const tooLong =
    lines.length > HIGHLIGHT_LIMIT.lines ||
    lines.some((l) => l.length > HIGHLIGHT_LIMIT.lineLength);
  const tokens = useLineTokens(
    body,
    path,
    settings?.codeTheme ?? 'github',
    (settings?.sourceSyntax ?? true) && !tooLong,
  );
  const scroller = useRef<HTMLDivElement>(null);
  const virtualize = lines.length >= VIRTUALIZE_FROM;
  const virtual = useVirtualizer({
    count: virtualize ? lines.length : 0,
    enabled: virtualize,
    getScrollElement: () => scroller.current,
    estimateSize: () => 20,
    overscan: 30,
  });
  const gutter = `${String(lines.length).length + 1}ch`;

  // A line from a pull request comment or a link opens scrolled to it.
  useEffect(() => {
    if (!line || line > lines.length) return;
    if (virtualize) virtual.scrollToIndex(line - 1, { align: 'center' });
    else
      scroller.current
        ?.querySelector(`[data-line="${line}"]`)
        ?.scrollIntoView({ block: 'center' });
  }, [line, lines.length, virtualize, virtual]);

  const renderLine = (
    index: number,
    measure?: (el: Element | null) => void,
  ) => {
    const content = lines[index]!;
    const lineTokens: CodeToken[] | null = tokens?.[index] ?? null;
    return (
      <div
        key={index}
        ref={measure}
        data-index={index}
        data-line={index + 1}
        className={cn(
          'flex min-h-[var(--code-line)]',
          index + 1 === line && 'bg-accent-soft',
        )}
      >
        {numbers && (
          <span
            aria-hidden
            className="sticky left-0 shrink-0 border-r border-line bg-surface pr-3 pl-4 text-right text-muted select-none"
            style={{ width: `calc(${gutter} + 1.75rem)` }}
          >
            {index + 1}
          </span>
        )}
        <span
          className={cn(
            'min-w-0 pr-6 pl-4',
            wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre',
          )}
        >
          {lineTokens
            ? lineTokens.map((token, t) => (
                <span key={t} className="code-token" style={token.style}>
                  {token.content}
                </span>
              ))
            : content || ' '}
        </span>
      </div>
    );
  };

  return (
    <>
      {tooLong && (settings?.sourceSyntax ?? true) && (
        <p className="flex-none border-b border-line px-6 py-1.5 text-xs text-muted">
          Syntax colors are off for files over{' '}
          {HIGHLIGHT_LIMIT.lines.toLocaleString()} lines or with very long
          lines.
        </p>
      )}
      <div
        ref={scroller}
        role="region"
        aria-label={`Contents of ${path}`}
        tabIndex={0}
        className="code-text min-h-0 flex-1 overflow-auto py-2 outline-offset-[-2px]"
      >
        {virtualize ? (
          <div
            className="relative w-full"
            style={{ height: virtual.getTotalSize() }}
          >
            <div
              className={cn(
                'absolute top-0 left-0',
                wrap ? 'w-full' : 'w-max min-w-full',
              )}
              style={{
                transform: `translateY(${virtual.getVirtualItems()[0]?.start ?? 0}px)`,
              }}
            >
              {virtual
                .getVirtualItems()
                .map((item) => renderLine(item.index, virtual.measureElement))}
            </div>
          </div>
        ) : (
          <div className={wrap ? 'w-full' : 'w-max min-w-full'}>
            {lines.map((_l, i) => renderLine(i))}
          </div>
        )}
      </div>
    </>
  );
}

function ImageView({
  file,
  path,
}: {
  file: Extract<SourceFile, { kind: 'image' }>;
  path: string;
}) {
  const [source, setSource] = useState(false);
  const svg = file.mime === 'image/svg+xml';
  const text = useMemo(() => {
    if (!svg || !source) return null;
    const bytes = Uint8Array.from(atob(file.dataUrl.split(',')[1] ?? ''), (c) =>
      c.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  }, [svg, source, file.dataUrl]);
  if (text !== null)
    return (
      <>
        <div className="flex flex-none justify-end border-b border-line px-6 py-1.5">
          <Button size="sm" variant="ghost" onClick={() => setSource(false)}>
            Show the picture
          </Button>
        </div>
        <CodeView text={text} path={path} line={null} />
      </>
    );
  return (
    <div className="min-h-0 flex-1 overflow-auto p-6">
      {/* An <img>, never inline markup: an SVG's scripts and links don't run here. */}
      <div className="grid min-h-60 place-items-center rounded-sm bg-sunken p-6">
        <img
          src={file.dataUrl}
          alt={`Preview of ${path.split('/').pop()}`}
          className="max-h-[60vh] max-w-full object-contain"
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[0.8125rem] text-muted">
        <span>
          {fileType(path).label} · {formatBytes(file.size)}
        </span>
        {svg && (
          <Button size="sm" onClick={() => setSource(true)}>
            View source
          </Button>
        )}
      </div>
    </div>
  );
}

export type ViewerActions = {
  // Local files: open in the editor and show in the file manager. Hosted files: save a copy.
  local: { repoId: string; reveal: () => void; revealing: boolean } | null;
  remote: { save: () => void; saving: boolean } | null;
};

export function SourceViewer({
  entry,
  file,
  isLoading,
  error,
  snapshotLabel,
  line,
  actions,
  lastChange,
  onShowAnyway,
  onRefresh,
  refreshing,
  onCrumb,
  onBack,
}: {
  entry: SourceEntry;
  file: Fetched<SourceFile> | undefined;
  isLoading: boolean;
  error: unknown;
  snapshotLabel: string;
  line: number | null;
  actions: ViewerActions;
  lastChange: {
    author: string;
    at: number;
    oid: string;
    subject: string;
  } | null;
  onShowAnyway: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  onCrumb: (dir: string) => void;
  onBack: (() => void) | null;
}) {
  const name = entry.path.split('/').pop()!;
  const parts = entry.path.split('/');
  const type = fileType(entry.path);
  const value = file?.ok ? file.value : null;
  const text = value?.kind === 'text' ? value.text : null;
  const lineCount = text !== null ? linesOf(text).length : null;
  const status = entry.status;

  const meta = [
    entry.type === 'symlink'
      ? 'Symbolic link'
      : entry.type === 'submodule'
        ? 'Submodule'
        : type.label,
    snapshotLabel,
    status
      ? status.staged && status.unstaged
        ? 'Staged, then changed again'
        : `${STATUS_LABEL[status.code] ?? status.code}${status.staged ? ', staged' : status.kind === 'modified' ? ', not staged' : ''}`
      : null,
    lineCount !== null
      ? `${lineCount.toLocaleString()} ${lineCount === 1 ? 'line' : 'lines'}`
      : null,
    value && 'size' in value && value.size !== null
      ? formatBytes(value.size)
      : null,
    value?.kind === 'text' && value.eol !== 'none'
      ? value.eol.toUpperCase()
      : null,
  ].filter(Boolean);

  const save = actions.remote && (
    <Button
      size="sm"
      pending={actions.remote.saving}
      onClick={actions.remote.save}
    >
      {!actions.remote.saving && <Download />}
      Save a copy
    </Button>
  );
  const reveal = actions.local && (
    <Button
      size="sm"
      pending={actions.local.revealing}
      onClick={actions.local.reveal}
    >
      {!actions.local.revealing && <FolderOpen />}
      {fileManagerLabel()}
    </Button>
  );
  const editor = actions.local && (
    <OpenInEditorButton
      repoId={actions.local.repoId}
      path={entry.path}
      line={line}
    />
  );

  let body: ReactNode;
  if (isLoading && !file)
    body = (
      <div className="px-6">
        <Loading label={`Opening ${name}`} />
      </div>
    );
  else if (error || !file)
    body = (
      <EmptyState
        compact
        className="px-6"
        art={<FileArt />}
        title={`Couldn't open ${name}`}
        action={
          <Button size="sm" pending={refreshing} onClick={onRefresh}>
            {!refreshing && <RefreshCw />}
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(
          error,
          'Git stopped before it read the file. Your files are unchanged.',
        )}
      </EmptyState>
    );
  else if (!file.ok)
    body = (
      <EmptyState
        compact
        className="px-6"
        art={file.problem === 'offline' ? <OfflineArt /> : <FileArt />}
        title={PROBLEM_TEXT[file.problem].title}
        action={
          <Button size="sm" pending={refreshing} onClick={onRefresh}>
            {!refreshing && <RefreshCw />}
            Try again
          </Button>
        }
      >
        {PROBLEM_TEXT[file.problem].body}
      </EmptyState>
    );
  else {
    const f = file.value;
    if (f.kind === 'text')
      body = f.text ? (
        <CodeView text={f.text} path={entry.path} line={line} />
      ) : (
        <EmptyState
          compact
          className="px-6"
          art={<FileArt />}
          title={`${name} is empty`}
          action={
            <CopyButton value={entry.path} label="path" text="Copy path" />
          }
        >
          The file has no content in this snapshot.
        </EmptyState>
      );
    else if (f.kind === 'image')
      body = <ImageView file={f} path={entry.path} />;
    else if (f.kind === 'too-large' && f.canForce)
      body = (
        <div className="px-6 py-4">
          <div className="flex items-start gap-2.5 rounded-sm bg-warning-soft p-3 text-sm text-ink">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              <b className="font-semibold">
                {name} is {f.size === null ? 'large' : formatBytes(f.size)}.
              </b>{' '}
              Files over {formatBytes(f.limit)} open on request, so the window
              stays quick. You can change that in Settings, Files.
              <div className="mt-2.5">
                <Button
                  size="sm"
                  variant="primary"
                  pending={isLoading}
                  onClick={onShowAnyway}
                >
                  Show anyway
                </Button>
              </div>
            </div>
          </div>
        </div>
      );
    else if (f.kind === 'too-large')
      body = (
        <EmptyState
          compact
          className="px-6"
          art={<FileArt />}
          title={`${name} is ${f.size === null ? 'too large' : formatBytes(f.size)}`}
          action={editor ?? save}
        >
          gitdesk shows text files up to 5 MB.{' '}
          {actions.local
            ? 'Open it in your editor to read it.'
            : 'Save a copy to read it.'}
        </EmptyState>
      );
    else if (f.kind === 'binary')
      body = (
        <EmptyState
          compact
          className="px-6"
          art={<FileArt />}
          title={
            f.reason === 'encoding'
              ? `${name} isn’t UTF-8 text`
              : `${name} is binary`
          }
          action={reveal ?? save}
        >
          {f.reason === 'encoding'
            ? 'It may use another text encoding. gitdesk shows UTF-8 only, so nothing is shown garbled.'
            : `It can't be shown as text. ${formatBytes(f.size)}, ${type.label.toLowerCase()}.`}
        </EmptyState>
      );
    else if (f.kind === 'symlink')
      body = (
        <EmptyState
          compact
          className="px-6"
          art={<LinkArt />}
          title={`${name} is a link`}
          action={
            <CopyButton
              value={f.target}
              label="link target"
              text="Copy link target"
            />
          }
        >
          It points to <span className="font-mono text-ink">{f.target}</span>.
          gitdesk shows the link itself and doesn’t follow it.
        </EmptyState>
      );
    else if (f.kind === 'submodule')
      body = (
        <EmptyState
          compact
          className="px-6"
          art={<RepositoriesArt />}
          title={`${name} is its own repository`}
          action={
            reveal ?? (
              <CopyButton value={entry.path} label="path" text="Copy path" />
            )
          }
        >
          Its files belong to another Git repository
          {f.oid ? `, pinned at ${f.oid.slice(0, 7)}` : ''}.
        </EmptyState>
      );
    else
      body = (
        <EmptyState
          compact
          className="px-6"
          art={<FolderMissingArt />}
          title={`${name} isn’t here anymore`}
          action={
            <Button size="sm" pending={refreshing} onClick={onRefresh}>
              {!refreshing && <RefreshCw />}
              Refresh
            </Button>
          }
        >
          It was moved or deleted after the list was read.
        </EmptyState>
      );
  }

  return (
    <section aria-label={name} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-none flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-6 py-3">
        <div className="min-w-0">
          <nav
            aria-label="Path"
            className="flex min-w-0 flex-wrap items-center font-mono text-[0.78125rem] text-muted"
          >
            {onBack && (
              <Button
                size="sm"
                variant="ghost"
                className="-ml-2 mr-1 font-sans"
                onClick={onBack}
              >
                <ArrowLeft /> All files
              </Button>
            )}
            {parts.slice(0, -1).map((part, i) => (
              <span key={i} className="flex items-center">
                <button
                  type="button"
                  className="rounded-[4px] px-0.5 hover:text-ink hover:underline focus-visible:outline-offset-0"
                  onClick={() => onCrumb(parts.slice(0, i + 1).join('/'))}
                >
                  {part}
                </button>
                <span aria-hidden className="px-1">
                  /
                </span>
              </span>
            ))}
            <span className="font-semibold text-ink">{name}</span>
          </nav>
          <p className="mt-1 text-[0.8125rem] text-muted">{meta.join(' · ')}</p>
        </div>
        <div className="flex flex-none flex-wrap items-center gap-1">
          <CopyButton value={entry.path} label="path" />
          {text !== null && (
            <CopyButton value={text} label="contents" text="Copy contents" />
          )}
          {actions.local && reveal}
          {actions.local ? editor : save}
        </div>
      </div>
      {lastChange && (
        <p className="flex flex-none items-center gap-2 border-b border-line px-6 py-2 text-[0.8125rem] text-muted">
          <Avatar name={lastChange.author} className="size-5 text-[0.625rem]" />
          <span className="min-w-0 truncate">
            Last changed {relativeTime(lastChange.at)} by{' '}
            <span className="text-ink">{lastChange.author}</span> ·{' '}
            <span className="font-mono">{lastChange.oid.slice(0, 7)}</span> ·{' '}
            {lastChange.subject}
          </span>
        </p>
      )}
      {body}
    </section>
  );
}
