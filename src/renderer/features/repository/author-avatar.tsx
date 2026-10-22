import { Avatar } from '../../components/ui/avatar';
import { cn } from '../../lib/cn';
import { useAuthStatus, useGitIdentity } from '../../lib/queries';

// The emails that mean "this commit is yours": the gitdesk account's and the global Git identity's.
export function useMyEmails(): Set<string> {
  const { data: auth } = useAuthStatus();
  const { data: identity } = useGitIdentity();
  const emails = new Set<string>();
  const account =
    auth?.status === 'authenticated' || auth?.status === 'offline'
      ? auth.account
      : null;
  if (account?.email) emails.add(account.email.toLowerCase());
  if (identity?.available && identity.email)
    emails.add(identity.email.toLowerCase());
  return emails;
}

// A 6px-rounded square: your gitdesk account picture on your own commits, initials for everyone
// else. Git has no pictures of its own, and nothing here asks another service for one.
export function AuthorAvatar({
  name,
  email,
  size = 'md',
  className,
}: {
  name: string;
  email: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const { data: auth } = useAuthStatus();
  const mine = useMyEmails().has(email.toLowerCase());
  const account =
    auth?.status === 'authenticated' || auth?.status === 'offline'
      ? auth.account
      : null;
  return (
    <span aria-hidden className="contents">
      <Avatar
        name={name || email || '?'}
        src={mine ? account?.avatarUrl : null}
        className={cn(
          size === 'sm' ? 'size-6' : size === 'lg' ? 'size-8' : 'size-7',
          !mine && 'bg-control [&>span]:text-ink',
          className,
        )}
      />
    </span>
  );
}
