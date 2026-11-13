import type { McpApi, McpLocalStatus } from '../../shared/mcp';

export const offMcpStatus: McpLocalStatus = {
  enabled: false,
  listening: false,
  error: null,
  writes: false,
  command: '/opt/gitdesk/gitdesk',
  args: ['--mcp'],
  repositories: [],
  clients: [],
  approvals: [],
};

// The MCP bridge for tests that aren't about MCP: turned off, nothing connected.
export const idleMcp = (status: McpLocalStatus = offMcpStatus): McpApi => ({
  localStatus: async () => status,
  setRepositories: async () => status,
  copyConfig: async () => {},
  localCalls: async () => [],
  decide: async () => status,
  remoteStatus: async () => ({
    endpoint: 'https://api.example/mcp',
    grants: [],
    more: false,
    calls: [],
  }),
  revokeGrant: async () => {},
  onChanged: () => () => {},
});
