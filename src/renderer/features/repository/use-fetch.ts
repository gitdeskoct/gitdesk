import { useState } from 'react';
import type { FetchResult } from '../../../shared/workspace';
import { useToast } from '../../components/ui/toast';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useCancelFetch, useFetch, useJobProgress } from '../../lib/queries';

// One fetch at a time per view: the remote it targets, its live progress and its outcome.
export function useFetchAction(
  repoId: string,
  options: { toast?: boolean } = {},
) {
  const fetch = useFetch(repoId);
  const cancel = useCancelFetch();
  const toast = useToast();
  const [job, setJob] = useState<{ id: string; remote: string } | null>(null);
  const [result, setResult] = useState<
    (FetchResult & { remote: string }) | null
  >(null);
  const progress = useJobProgress(job?.id ?? null);

  return {
    running: job,
    progress,
    result,
    start(remote: string) {
      if (job) return;
      const id = crypto.randomUUID();
      setJob({ id, remote });
      setResult(null);
      fetch.mutate(
        { remote, jobId: id },
        {
          onSuccess: (outcome) => {
            setResult({ ...outcome, remote });
            if (options.toast)
              toast(
                outcome.status === 'fetched'
                  ? { tone: 'success', title: `Fetched ${remote}` }
                  : {
                      tone: 'danger',
                      title: `Didn't fetch ${remote}`,
                      description: outcome.message,
                    },
              );
          },
          onError: (err) => {
            const message = ipcErrorMessage(
              err,
              'Git could not fetch. Try again.',
            );
            setResult({ status: 'failed', reason: 'failed', message, remote });
            if (options.toast)
              toast({
                tone: 'danger',
                title: `Didn't fetch ${remote}`,
                description: message,
              });
          },
          onSettled: () => setJob(null),
        },
      );
    },
    cancel() {
      if (job) cancel.mutate(job.id);
    },
  };
}
