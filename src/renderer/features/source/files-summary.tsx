import { FolderOpen, RefreshCw } from 'lucide-react';
import type { RepositorySummary } from '../../../shared/repos';
import { FilesArt, OfflineArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { Loading } from '../../components/ui/status';
import { useNavigation } from '../../app/navigation';
import { formatDate } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { ChartTable } from '../repository/analytics';
import { Section, SummaryStrip } from '../repository/history';
import { FILE_ICONS } from './file-icons';
import { useSourceStats } from './source-queries';

// What kinds of files make up the repository, counted from Git's index: files, not bytes, so a
// lockfile counts once however large it is. Answers "what is this project made of?".
export function FilesSummary({ repo }: { repo: RepositorySummary }) {
  const { navigate } = useNavigation();
  const stats = useSourceStats(repo, repo.availability === 'available');
  const browse = (
    <Button
      size="sm"
      onClick={() =>
        navigate({ name: 'repository', id: repo.id, tab: 'source' })
      }
    >
      <FolderOpen /> Browse in Files
    </Button>
  );

  let body;
  if (stats.isPending) body = <Loading label="Counting files…" />;
  else if (stats.isError)
    body = (
      <EmptyState
        compact
        art={<OfflineArt />}
        title="Couldn't count the files"
        action={
          <Button
            size="sm"
            pending={stats.isFetching}
            onClick={() => void stats.refetch()}
          >
            {!stats.isFetching && <RefreshCw />}
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(stats.error, 'Git did not answer.')}
      </EmptyState>
    );
  else if (!stats.data.files)
    body = (
      <EmptyState
        compact
        art={<FilesArt />}
        title="No tracked files yet"
        action={browse}
      >
        Files show up here once you stage or commit them.
      </EmptyState>
    );
  else {
    const data = stats.data;
    const top = data.groups[0];
    const max = Math.max(1, ...data.groups.map((g) => g.count));
    body = (
      <>
        <SummaryStrip
          cells={[
            {
              label: 'Tracked files',
              value: data.files.toLocaleString(),
              context: 'In the index',
            },
            {
              label: 'Folders',
              value: data.dirs.toLocaleString(),
              context: 'That hold them',
            },
            {
              label: 'Changed now',
              value: data.changed.toLocaleString(),
              context: 'Working tree and staged',
            },
            {
              label: 'Most files',
              value: top?.label ?? 'None',
              context: top ? `${top.count.toLocaleString()} files` : '',
              word: true,
            },
          ]}
        />
        <h3 className="mt-6 text-sm font-semibold text-ink">
          Which kinds of files this repository holds, by count
        </h3>
        <p className="mt-0.5 mb-2 text-[0.8125rem] text-muted">
          {top
            ? `${top.label} makes up ${Math.round((top.count / data.files) * 100)}% of the tracked files.`
            : 'No tracked files to group.'}
        </p>
        <ol className="border-t border-line">
          {data.groups.map((group) => {
            const Icon = FILE_ICONS[group.icon];
            return (
              <li
                key={group.label}
                className="grid h-9 grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_3rem] items-center gap-3 border-b border-line"
              >
                <span className="flex min-w-0 items-center gap-2 text-[0.8125rem] text-ink">
                  <Icon aria-hidden className="size-4 shrink-0 text-muted" />
                  <span className="truncate">{group.label}</span>
                </span>
                <span
                  aria-hidden
                  className="block h-2.5 rounded-r-[4px] bg-chart-1"
                  style={{ width: `${(group.count / max) * 100}%` }}
                />
                <span className="text-right text-xs text-ink tabular-nums">
                  {group.count.toLocaleString()}
                  <span className="sr-only"> files</span>
                </span>
              </li>
            );
          })}
        </ol>
        <details className="mt-2">
          <summary className="cursor-default text-xs text-muted hover:text-ink">
            Show as a table
          </summary>
          <ChartTable
            caption="Tracked files by kind"
            head={['Kind', 'Files']}
            rows={data.groups.map((g) => [g.label, g.count])}
          />
        </details>
        <div className="mt-3">{browse}</div>
      </>
    );
  }

  return (
    <Section
      id="files-heading"
      title="Files"
      meta={
        stats.data
          ? `Counted from Git's index, ${formatDate(stats.data.countedAt)}${stats.data.truncated ? ', first 200,000 files' : ''}`
          : undefined
      }
    >
      <div className="@container">{body}</div>
    </Section>
  );
}
