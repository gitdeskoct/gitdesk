import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import type { InstallMode, UpdateStatus } from '../../shared/updates';

export const updateKeys = { status: ['update-status'] as const };

const updates = () => window.desktop.updates;

export const useUpdateStatus = () =>
  useQuery({
    queryKey: updateKeys.status,
    queryFn: () => updates().status(),
    staleTime: Infinity,
  });

// Main pushes every change (progress included), so nothing here polls.
export function useUpdateSync(qc: QueryClient) {
  useEffect(
    () =>
      updates().onChanged((status) =>
        qc.setQueryData(updateKeys.status, status),
      ),
    [qc],
  );
}

function useUpdateMutation<I>(fn: (input: I) => Promise<UpdateStatus>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (status) => qc.setQueryData(updateKeys.status, status),
  });
}

export const useCheckForUpdates = () =>
  useUpdateMutation(() => updates().check());
// Pending for the whole download, so its button keeps the spinner until the file is checked.
export const useDownloadUpdate = () =>
  useUpdateMutation(() => updates().download());
export const useInstallUpdate = () =>
  useUpdateMutation((mode: InstallMode) => updates().install(mode));
export const useOpenReleasePage = () =>
  useMutation({ mutationFn: () => updates().openReleasePage() });
