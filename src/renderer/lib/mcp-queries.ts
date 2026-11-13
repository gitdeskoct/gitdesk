import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import type { McpLocalStatus } from '../../shared/mcp';

export const mcpKeys = {
  local: ['mcp-local'] as const,
  localCalls: ['mcp-local-calls'] as const,
  remote: ['mcp-remote'] as const,
};

const mcp = () => window.desktop.mcp;

export const useMcpLocal = () =>
  useQuery({
    queryKey: mcpKeys.local,
    queryFn: () => mcp().localStatus(),
    staleTime: Infinity,
  });

// Main pushes connections, approvals and the shared list as they change, so nothing here polls.
// An approval that ends has usually left a new line in the activity list.
export function useMcpSync(qc: QueryClient) {
  useEffect(
    () =>
      mcp().onChanged((status) => {
        qc.setQueryData(mcpKeys.local, status);
        void qc.invalidateQueries({ queryKey: mcpKeys.localCalls });
      }),
    [qc],
  );
}

export const useMcpLocalCalls = (enabled: boolean) =>
  useQuery({
    queryKey: mcpKeys.localCalls,
    queryFn: () => mcp().localCalls(),
    enabled,
  });

function useLocalMutation<I>(fn: (input: I) => Promise<McpLocalStatus>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (status) => qc.setQueryData(mcpKeys.local, status),
  });
}

export const useSetMcpRepositories = () =>
  useLocalMutation((repositories: string[]) =>
    mcp().setRepositories(repositories),
  );

export const useDecideMcpApproval = () =>
  useLocalMutation((input: { id: string; allow: boolean }) =>
    mcp().decide(input),
  );

export const useCopyMcpConfig = () =>
  useMutation({ mutationFn: () => mcp().copyConfig() });

export const useMcpRemote = (enabled: boolean) =>
  useQuery({
    queryKey: mcpKeys.remote,
    queryFn: () => mcp().remoteStatus(),
    enabled,
  });

export function useRevokeMcpGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mcp().revokeGrant(id),
    onSettled: () => qc.invalidateQueries({ queryKey: mcpKeys.remote }),
  });
}
