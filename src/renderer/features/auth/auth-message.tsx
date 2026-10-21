import { InlineStatus } from '../../components/ui/status';
import { cn } from '../../lib/cn';
import type { AuthMessage } from './messages';

const titleTone = {
  danger: 'text-danger',
  warning: 'text-warning',
  info: 'text-ink',
};

// The colored title is weight 600 and sits beside an icon: success and warning tones are 4.4:1 on white.
export function AuthMessageLine({
  message,
  className,
}: {
  message: AuthMessage;
  className?: string;
}) {
  return (
    <InlineStatus tone={message.tone} className={className}>
      <span className={cn('font-semibold', titleTone[message.tone])}>
        {message.title}
      </span>{' '}
      {message.body}
    </InlineStatus>
  );
}
