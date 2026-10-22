import { useState } from 'react';
import { useToast } from '../../components/ui/toast';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useCancelPush, useJobProgress, usePush } from '../../lib/queries';

// One push at a time per view. Its result arrives as a toast because the button that started it
// has already gone back to its idle label.
export function usePushAction(repoId: string) {
  const push = usePush(repoId);
  const cancel = useCancelPush();
  const toast = useToast();
  const [jobId, setJobId] = useState<string | null>(null);
  const progress = useJobProgress(jobId);

  return {
    running: jobId !== null,
    progress,
    start() {
      if (jobId) return;
      const id = crypto.randomUUID();
      setJobId(id);
      push.mutate(id, {
        onSuccess: (outcome) =>
          toast(
            outcome.status === 'pushed'
              ? {
                  tone: 'success',
                  title: `Pushed ${outcome.branch} to ${outcome.remote}`,
                }
              : {
                  tone: 'danger',
                  title: "Didn't push",
                  description: outcome.message,
                },
          ),
        onError: (err) =>
          toast({
            tone: 'danger',
            title: "Didn't push",
            description: ipcErrorMessage(err, 'Git could not push. Try again.'),
          }),
        onSettled: () => setJobId(null),
      });
    },
    cancel() {
      if (jobId) cancel.mutate(jobId);
    },
  };
}
