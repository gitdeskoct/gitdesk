import { useState } from 'react';
import type { PullResult, PullStrategy } from '../../../shared/sync';
import { useToast } from '../../components/ui/toast';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useJobProgress } from '../../lib/queries';
import { useCancelSync, usePullUpstream } from '../../lib/sync-queries';

// One pull at a time per view. A finished pull is a toast; a stopped one stays on the tab, where
// the reason and the files it names can be read.
// With `toast`, a stopped pull is a toast too: the header button has nowhere to show the reason.
export function usePullAction(
  repoId: string,
  options: { toast?: boolean } = {},
) {
  const pull = usePullUpstream(repoId);
  const cancel = useCancelSync();
  const toast = useToast();
  const [jobId, setJobId] = useState<string | null>(null);
  const [stopped, setStopped] = useState<Extract<
    PullResult,
    { status: 'stopped' }
  > | null>(null);
  const progress = useJobProgress(jobId);

  return {
    running: jobId !== null,
    progress,
    stopped,
    dismiss: () => setStopped(null),
    start(strategy: PullStrategy) {
      if (jobId) return;
      const id = crypto.randomUUID();
      setJobId(id);
      setStopped(null);
      pull.mutate(
        { jobId: id, strategy },
        {
          onSuccess: (result) => {
            if (result.status === 'stopped') {
              setStopped(result);
              if (options.toast)
                toast({
                  tone: 'danger',
                  title: "Didn't pull",
                  description: result.message,
                });
            }
            if (result.status === 'conflicts')
              toast({
                tone: 'danger',
                title: `Pulling ${result.upstream} stopped on conflicts`,
                description: 'Resolve them on the Sync tab to finish.',
              });
            if (result.status === 'pulled')
              toast({
                tone: 'success',
                title:
                  result.mode === 'up-to-date'
                    ? `${result.branch} already has everything on ${result.upstream}`
                    : `Pulled ${result.upstream} into ${result.branch}`,
              });
          },
          onError: (err) =>
            setStopped({
              status: 'stopped',
              code: 'FAILED',
              message: ipcErrorMessage(
                err,
                'Git could not pull. Nothing changed.',
              ),
              files: [],
            }),
          onSettled: () => setJobId(null),
        },
      );
    },
    cancel() {
      if (jobId) cancel.mutate(jobId);
    },
  };
}
