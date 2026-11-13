import { Bot } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { useDecideMcpApproval, useMcpLocal } from '../../lib/mcp-queries';
import { Line } from '../shell/connection-status';

// Details listed in the band; the rest are counted from the approval's total.
const SHOWN = 5;

// A change an agent asked for, waiting for an answer. It sits under the page header on every
// page, inline like the connection line: never a dialog, and nothing happens until Allow.
// Both answers look alike on purpose: the page's own primary action stays the only one, and
// nothing nudges toward Allow.
export function McpApprovalBand() {
  const { data } = useMcpLocal();
  const decide = useDecideMcpApproval();
  const approval = data?.approvals[0];
  if (!approval) return null;
  const waiting = data.approvals.length - 1;
  const deciding = (allow: boolean) =>
    decide.isPending &&
    decide.variables?.id === approval.id &&
    decide.variables.allow === allow;
  return (
    <Line
      icon={<Bot />}
      tone="warning"
      action={
        <span className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            pending={deciding(false)}
            onClick={() => decide.mutate({ id: approval.id, allow: false })}
          >
            Deny
          </Button>
          <Button
            size="sm"
            pending={deciding(true)}
            onClick={() => decide.mutate({ id: approval.id, allow: true })}
          >
            Allow
          </Button>
        </span>
      }
    >
      {/* The name is the agent's own claim; the band says so rather than vouching for it. */}
      <span className="font-semibold">
        {approval.client}{' '}
        <span className="font-normal text-muted">(as it calls itself)</span>{' '}
        wants to change {approval.repositoryName}:
      </span>{' '}
      {approval.summary}.
      {approval.details.length > 0 && (
        <span className="mt-0.5 block font-mono text-xs break-all text-muted">
          {approval.details.slice(0, SHOWN).join(' · ')}
          {approval.total > SHOWN && ` · and ${approval.total - SHOWN} more`}
        </span>
      )}
      {waiting > 0 && (
        <span className="mt-0.5 block text-muted">
          {waiting === 1 ? '1 more request is' : `${waiting} more requests are`}{' '}
          waiting after this one.
        </span>
      )}
    </Line>
  );
}
