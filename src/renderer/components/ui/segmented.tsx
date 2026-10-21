import * as RadioGroup from '@radix-ui/react-radio-group';
import { cn } from '../../lib/cn';

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  label: string;
}) {
  return (
    <RadioGroup.Root
      aria-label={label}
      value={value}
      onValueChange={(next) => onChange(next as T)}
      orientation="horizontal"
      className="inline-flex rounded-sm border border-faint bg-sunken p-0.5"
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          className={cn(
            'h-7 rounded-[4px] px-3 text-sm text-muted transition-colors hover:text-ink',
            'data-[state=checked]:bg-surface data-[state=checked]:font-medium data-[state=checked]:text-ink data-[state=checked]:shadow-[0_0_0_1px_var(--line-strong)]',
          )}
        >
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
