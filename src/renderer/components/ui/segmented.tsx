import * as RadioGroup from '@radix-ui/react-radio-group';
import { cn } from '../../lib/cn';

// A solid track; the checked thumb lifts with a 1px shadow because it sits on that track.
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <RadioGroup.Root
      aria-label={label}
      value={value}
      onValueChange={(next) => onChange(next as T)}
      orientation="horizontal"
      className={cn('inline-flex gap-0.5 rounded-sm bg-control p-0.5', className)}
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          className={cn(
            'h-7 rounded-[4px] px-3 text-[0.8125rem] whitespace-nowrap text-muted transition-colors hover:text-ink focus-visible:outline-offset-0',
            'data-[state=checked]:bg-thumb data-[state=checked]:font-medium data-[state=checked]:text-ink data-[state=checked]:shadow-[0_1px_2px_rgb(20_22_26/0.12)]',
          )}
        >
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
