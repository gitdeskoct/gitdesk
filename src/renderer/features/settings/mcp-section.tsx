import { CircleAlert, CircleCheck, CircleSlash } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AuthStatus } from '../../../shared/ipc';
import {
  SCOPE_LABELS,
  shellCommand,
  type McpCall,
  type McpGrant,
} from '../../../shared/mcp';
import { LinkArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { EmptyState } from '../../components/ui/empty-state';
import { LongValue } from '../../components/ui/long-value';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { InlineStatus, Loading } from '../../components/ui/status';
import { Switch } from '../../components/ui/switch';
import { useToast } from '../../components/ui/toast';
import { formatDate, relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useCopyMcpConfig,
  useMcpLocal,
  useMcpLocalCalls,
  useMcpRemote,
  useRevokeMcpGrant,
  useSetMcpRepositories,
} from '../../lib/mcp-queries';
import {
  useRepositories,
  useSettings,
  useSignIn,
  useUpdateSettings,
} from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { PageTitle } from '../shell/page';

const REASONS: Record<string, string> = {
  DENIED: 'You chose Deny',
  TIMED_OUT: 'Nobody answered in time',
  NOT_ALLOWED: 'Asked for a repository that is not shared',
  WRITES_OFF: 'Changes were turned off',
  MCP_OFF: 'MCP was turned off',
  RATE_LIMITED: 'Too many requests',
  MISSING_SCOPE: 'Not permitted for this agent',
  SECRET_FILE: 'Asked for a file that looks like credentials',
  REFUSED_BY_GIT: 'Git or gitdesk refused it',
  INVALID_STATE: 'The pull request was not in a state for it',
  NO_COMPARISON: 'The pull request had no comparison yet',
  STALE: 'The pull request changed meanwhile',
  NOT_FOUND: 'Asked for something not in your account',
  CANCELLED: 'The agent left before you answered',
  STATE_CHANGED: 'The repository changed after you were asked',
  NOTHING_STAGED: 'Nothing was staged',
  DETACHED: 'No branch was checked out',
  NO_REMOTE: 'The repository has no such remote',
  INVALID: 'The request was not valid',
  TOO_LARGE: 'The answer was too large',
  INTERNAL: 'gitdesk could not finish it',
};

const OUTCOMES = {
  ok: { icon: CircleCheck, tone: 'text-success', word: 'Done' },
  refused: { icon: CircleSlash, tone: 'text-warning', word: 'Refused' },
  failed: { icon: CircleAlert, tone: 'text-danger', word: 'Failed' },
};

// Changes and refusals only; reads are not listed. Icon and word together, never color alone.
function Calls({ title, calls }: { title: string; calls: McpCall[] }) {
  if (!calls.length) return null;
  return (
    <SettingGroup title={title}>
      {calls.map((call) => {
        const { icon: Icon, tone, word } = OUTCOMES[call.outcome];
        return (
          <div key={call.id} className="flex items-start gap-2.5 py-3 text-sm">
            <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${tone}`} />
            <div className="min-w-0 flex-1">
              <div className="text-ink">
                <span className="font-medium">{call.client}</span>{' '}
                <span className="font-mono text-[0.8125rem]">
                  {call.tool === '*' ? 'any tool' : call.tool}
                </span>
                {call.repositoryName && ` in ${call.repositoryName}`}
              </div>
              <div className="text-[0.8125rem] text-muted">
                {word}
                {call.reason &&
                  `: ${REASONS[call.reason] ?? 'gitdesk could not finish it'}`}
                {' · '}
                {relativeTime(call.at)}
              </div>
            </div>
          </div>
        );
      })}
    </SettingGroup>
  );
}

function LocalGroup() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const local = useMcpLocal();
  const repositories = useRepositories();
  const share = useSetMcpRepositories();
  const copy = useCopyMcpConfig();
  const toast = useToast();
  const calls = useMcpLocalCalls(!!settings?.mcpLocal);
  if (!settings) return null;
  const status = local.data;
  const shared = new Set(status?.repositories ?? []);
  const list = repositories.data ?? [];

  return (
    <>
      <SettingGroup title="This computer">
        <SettingRow
          id="mcp-local"
          label="Let agents on this computer connect"
          description={
            <>
              An agent you run here starts gitdesk's connector and reads the
              repositories you pick below, straight from your folders. It works
              while gitdesk is open, with or without an account.
              {settings.mcpLocal && status?.error && (
                <InlineStatus tone="danger" className="mt-2">
                  {status.error}
                </InlineStatus>
              )}
            </>
          }
        >
          <Switch
            aria-label="Let agents on this computer connect"
            checked={settings.mcpLocal}
            onCheckedChange={(mcpLocal) => update.mutate({ mcpLocal })}
          />
        </SettingRow>
        {settings.mcpLocal && !status && (
          <SettingRow
            id="mcp-setup"
            label="Agent setup"
            description={
              local.isError ? (
                <InlineStatus
                  tone="danger"
                  className="mt-2"
                  action={
                    <Button
                      size="sm"
                      pending={local.isFetching}
                      onClick={() => void local.refetch()}
                    >
                      Try again
                    </Button>
                  }
                >
                  {ipcErrorMessage(
                    local.error,
                    "Couldn't read the connection for agents.",
                  )}
                </InlineStatus>
              ) : (
                <Loading label="Loading the connection for agents…" />
              )
            }
          />
        )}
        {settings.mcpLocal && status && (
          <>
            <SettingRow
              id="mcp-setup"
              label="Agent setup"
              description={
                <>
                  Paste the setup into your agent's MCP settings. It starts this
                  program:
                  <LongValue
                    className="mt-1 text-[0.8125rem] text-ink"
                    value={shellCommand(status.command, status.args)}
                    label="command"
                  />
                  <span className="mt-1 block">
                    {status.clients.length
                      ? `Connected now: ${status.clients.join(', ')}. An agent names itself, so treat the name as its own claim.`
                      : 'No agent is connected right now.'}
                  </span>
                </>
              }
            >
              <Button
                size="sm"
                pending={copy.isPending}
                onClick={() =>
                  copy.mutate(undefined, {
                    onSuccess: () =>
                      toast({ tone: 'success', title: 'Setup copied' }),
                    onError: () =>
                      toast({
                        tone: 'danger',
                        title: "Couldn't copy the setup",
                      }),
                  })
                }
              >
                Copy setup
              </Button>
            </SettingRow>
            <SettingRow
              id="mcp-repositories"
              stacked
              label="Repositories agents can see"
              description={
                list.length
                  ? 'Only the ticked ones. An agent is told nothing about the rest, not even that they exist.'
                  : 'Add a repository to gitdesk first; it then appears here to share.'
              }
            >
              {list.length > 0 && (
                <ul className="grid min-w-0 gap-1">
                  {list.map((repo) => (
                    <li key={repo.id} className="min-w-0">
                      <label className="flex cursor-pointer items-center gap-2.5 rounded-sm py-1.5 text-sm text-ink hover:bg-row-hover">
                        <Checkbox
                          checked={shared.has(repo.id)}
                          disabled={share.isPending}
                          onCheckedChange={(checked) => {
                            const next = new Set(shared);
                            if (checked === true) next.add(repo.id);
                            else next.delete(repo.id);
                            share.mutate([...next]);
                          }}
                        />
                        <span className="min-w-0 truncate font-medium">
                          {repo.name}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] text-muted">
                          {repo.displayPath}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {share.isError && (
                <InlineStatus tone="danger">
                  {ipcErrorMessage(share.error, "Couldn't save that choice.")}
                </InlineStatus>
              )}
            </SettingRow>
            <SettingRow
              id="mcp-writes"
              label="Let agents ask to make changes"
              description="Create and switch branches, stage, commit, fetch, push and comment. Each request shows at the top of gitdesk and waits for you to choose Allow; with no answer in two minutes it is refused. Agents can never merge, discard, reset or force-push."
            >
              <Switch
                aria-label="Let agents ask to make changes"
                checked={settings.mcpLocalWrites}
                onCheckedChange={(mcpLocalWrites) =>
                  update.mutate({ mcpLocalWrites })
                }
              />
            </SettingRow>
          </>
        )}
      </SettingGroup>
      {settings.mcpLocal && (
        <Calls
          title="Changes and refusals on this computer"
          calls={calls.data ?? []}
        />
      )}
    </>
  );
}

function grantDescription(grant: McpGrant): string {
  const scopes = grant.scopes
    .filter((scope) => scope !== 'offline_access')
    .map((scope) => SCOPE_LABELS[scope].toLowerCase())
    .join(', ');
  const who = grant.clientDomain
    ? `Published by ${grant.clientDomain}.`
    : `Name not verified; access goes to ${grant.redirectHost || 'an unknown address'}.`;
  const used = grant.lastUsedAt
    ? `Last used ${relativeTime(grant.lastUsedAt)}.`
    : 'Not used yet.';
  return `Can ${scopes || 'do nothing'}. ${who} ${used} Connected ${formatDate(grant.createdAt)}.`;
}

function AccountGroup({ status }: { status: AuthStatus }) {
  const { data: settings } = useSettings();
  const signIn = useSignIn();
  const { navigate } = useNavigation();
  const signedIn = status.status === 'authenticated' && !settings?.localOnly;
  const remote = useMcpRemote(signedIn);
  const revoke = useRevokeMcpGrant();
  // Every state sits in the same group and row, so the page keeps its shape while it loads.
  const only = (description: ReactNode, action?: ReactNode) => (
    <SettingGroup title="Your account">
      <SettingRow
        id="mcp-endpoint"
        label="Agents connected to your account"
        description={description}
      >
        {action}
      </SettingRow>
    </SettingGroup>
  );

  // One state for both: agents reach the account only while gitdesk uses one.
  if (status.status === 'signed-out' || settings?.localOnly)
    return only(
      settings?.localOnly
        ? 'gitdesk is set to work without an account, so agents can reach only this computer. Turn off local-only mode to connect agents to your account.'
        : 'Sign in, and an agent running somewhere else can read the repositories stored in your account after you approve it in your browser. Agents on this computer work either way.',
      settings?.localOnly ? (
        <Button
          size="sm"
          onClick={() =>
            navigate({
              name: 'settings',
              section: 'general',
              row: 'local-only',
            })
          }
        >
          Open settings
        </Button>
      ) : (
        <Button
          size="sm"
          pending={signIn.isPending}
          onClick={() => signIn.mutate()}
        >
          Sign in
        </Button>
      ),
    );
  if (!signedIn)
    return only(
      <InlineStatus tone="warning" className="mt-2">
        Agents connected to your account load when gitdesk can reach the server
        again.
      </InlineStatus>,
    );
  if (remote.isPending)
    return only(<Loading label="Loading connected agents…" />);
  if (remote.isError)
    return only(
      <InlineStatus
        tone="danger"
        className="mt-2"
        action={
          <Button
            size="sm"
            pending={remote.isFetching}
            onClick={() => void remote.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(
          remote.error,
          "Couldn't load the agents connected to your account.",
        )}
      </InlineStatus>,
    );

  const { endpoint, grants, more, calls } = remote.data;
  return (
    <>
      <SettingGroup title="Your account">
        <SettingRow
          id="mcp-endpoint"
          stacked
          label="Server address for agents"
          description="Add this address to an agent as a remote MCP server. The agent opens your browser, where you pick what it may do and confirm your account with Google. It reads what is stored in your account, never the folders on this computer, and it cannot merge, push or delete."
        >
          <LongValue value={endpoint} label="address" />
        </SettingRow>
      </SettingGroup>
      {grants.length > 0 && (
        <div id="mcp-agents" className="scroll-mt-6">
          <SettingGroup title="Agents connected to your account">
            {grants.map((grant) => (
              <SettingRow
                key={grant.id}
                label={grant.clientName}
                description={grantDescription(grant)}
              >
                <Button
                  variant="danger"
                  size="sm"
                  pending={revoke.isPending && revoke.variables === grant.id}
                  onClick={() => revoke.mutate(grant.id)}
                >
                  {revoke.isPending && revoke.variables === grant.id
                    ? 'Revoking…'
                    : 'Revoke'}
                </Button>
              </SettingRow>
            ))}
          </SettingGroup>
        </div>
      )}
      {more && (
        <InlineStatus className="mt-4">
          Only the first 100 agents are listed.
        </InlineStatus>
      )}
      {revoke.isError && (
        <InlineStatus tone="danger" className="mt-4">
          {ipcErrorMessage(revoke.error, "Couldn't revoke that agent.")}
        </InlineStatus>
      )}
      {grants.length === 0 && (
        <EmptyState
          compact
          art={<LinkArt />}
          title="No agent is connected to your account"
          className="mt-6"
          action={
            <Button
              size="sm"
              pending={remote.isFetching}
              onClick={() => void remote.refetch()}
            >
              Check again
            </Button>
          }
        >
          An agent appears here after you approve it in your browser. Revoking
          it ends its access at once.
        </EmptyState>
      )}
      <Calls title="Changes and refusals in your account" calls={calls} />
    </>
  );
}

export function McpSection({ status }: { status: AuthStatus }) {
  return (
    <>
      <PageTitle title="MCP">
        AI agents that speak the Model Context Protocol can work with your
        repositories through gitdesk. Nothing is shared until you turn it on
        here.
      </PageTitle>
      <LocalGroup />
      <AccountGroup status={status} />
    </>
  );
}
