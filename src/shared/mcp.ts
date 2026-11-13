import { z } from 'zod';
import { repoIdSchema } from './repos';

// MCP: AI agents reaching gitdesk. Two connections, one page (Settings › MCP).
//   This computer   an agent starts `gitdesk --mcp`, which talks to the running app. Local Git,
//                   only the repositories picked here, changes only after Allow.
//   Your account    an agent signs in at the server's /mcp with OAuth. Hosted data only.

export const MCP_SCOPES = [
  'repo:read',
  'pr:read',
  'pr:write',
  'offline_access',
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export const SCOPE_LABELS: Record<McpScope, string> = {
  'repo:read': 'Read repositories',
  'pr:read': 'Read pull requests',
  'pr:write': 'Change pull requests',
  offline_access: 'Stay connected',
};

// What a local agent may ask for. The names match the account server's where the tool is the same.
export const LOCAL_READ_TOOLS = [
  'list_repositories',
  'get_status',
  'list_branches',
  'list_commits',
  'get_commit',
  'get_diff',
  'compare_branches',
  'check_mergeability',
  'list_files',
  'read_file',
  'list_pull_requests',
  'get_pull_request',
] as const;
export const LOCAL_WRITE_TOOLS = [
  'create_branch',
  'switch_branch',
  'stage_paths',
  'unstage_paths',
  'commit',
  'fetch',
  'push',
  'comment_on_pull_request',
] as const;
export type LocalWriteTool = (typeof LOCAL_WRITE_TOOLS)[number];

// The command as a person would type it in a POSIX shell, for reading and pasting. The setup JSON
// itself carries the program and arguments separately and needs no quoting.
export function shellCommand(command: string, args: string[]): string {
  const quote = (part: string) =>
    /^[\w@%+=:,./-]+$/u.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`;
  return [command, ...args].map(quote).join(' ');
}

// How long a change waits for Allow before the agent is told no.
export const APPROVAL_TIMEOUT_MS = 2 * 60_000;

export type McpApproval = {
  id: string;
  tool: LocalWriteTool;
  // The agent's own name for itself; shown as a claim, never as proof.
  client: string;
  repositoryId: string;
  repositoryName: string;
  // One line a person can check: "Commit 3 staged files: Fix the parser".
  summary: string;
  // The parts worth reading before saying yes: paths, a branch, a remote. At most 20.
  details: string[];
  // How many items `details` stands for, so the rest can be counted.
  total: number;
  requestedAt: number;
  expiresAt: number;
};

export type McpLocalStatus = {
  enabled: boolean;
  // False while enabled when the socket could not be opened; `error` then says why.
  listening: boolean;
  error: string | null;
  writes: boolean;
  // The program and arguments an agent's MCP settings need.
  command: string;
  args: string[];
  // Repositories agents may see. Ids that left gitdesk are dropped.
  repositories: string[];
  // Agents connected right now, by the name they gave.
  clients: string[];
  approvals: McpApproval[];
};

export const MCP_OUTCOMES = ['ok', 'refused', 'failed'] as const;
export type McpOutcome = (typeof MCP_OUTCOMES)[number];

export type McpCall = {
  id: string;
  client: string;
  tool: string;
  repositoryName: string | null;
  outcome: McpOutcome;
  // A short code: DENIED, TIMED_OUT, CANCELLED, STATE_CHANGED, NOT_ALLOWED, SECRET_FILE…
  reason: string | null;
  at: number;
};

export const mcpGrantSchema = z.object({
  id: z.string(),
  clientName: z.string(),
  clientDomain: z.string().nullable(),
  redirectHost: z.string(),
  scopes: z.array(z.enum(MCP_SCOPES)),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
  lastUsedAt: z.number().nullable(),
});
export type McpGrant = z.infer<typeof mcpGrantSchema>;

export type McpRemoteStatus = {
  endpoint: string;
  grants: McpGrant[];
  // More agents than one page lists.
  more: boolean;
  calls: McpCall[];
};

export const mcpRepositoriesInputSchema = z
  .object({ repositories: z.array(repoIdSchema).max(500) })
  .strict();
export const mcpApprovalInputSchema = z
  .object({ id: z.uuid(), allow: z.boolean() })
  .strict();
export const mcpGrantIdSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9._:~-]+$/);

export const MCP_IPC = {
  localStatus: 'mcp:local-status',
  setRepositories: 'mcp:set-repositories',
  copyConfig: 'mcp:copy-config',
  localCalls: 'mcp:local-calls',
  decide: 'mcp:decide',
  remoteStatus: 'mcp:remote-status',
  revokeGrant: 'mcp:revoke-grant',
  // Pushed from main: connections, approvals or the allowlist changed.
  changed: 'mcp:changed',
} as const;

export interface McpApi {
  localStatus(): Promise<McpLocalStatus>;
  setRepositories(repositories: string[]): Promise<McpLocalStatus>;
  // Copies the JSON an agent's MCP settings take. Returns nothing: the text never leaves main.
  copyConfig(): Promise<void>;
  localCalls(): Promise<McpCall[]>;
  decide(
    input: z.infer<typeof mcpApprovalInputSchema>,
  ): Promise<McpLocalStatus>;
  remoteStatus(): Promise<McpRemoteStatus>;
  revokeGrant(id: string): Promise<void>;
  onChanged(callback: (status: McpLocalStatus) => void): () => void;
}
