import { motion, useAnimationControls } from 'framer-motion';
import { useEffect } from 'react';
import { cn } from '../../lib/cn';

// The mark: a window holding a commit line and a branch merging into it. Line only, currentColor,
// no fill or background, so it inherits ink or accent and survives one-color use down to 16px.
const draw = { hidden: { pathLength: 0 }, shown: { pathLength: 1 } };

export function LogoMark({
  size = 24,
  className,
  animate = false,
}: {
  size?: number;
  className?: string;
  animate?: boolean;
}) {
  const branch = useAnimationControls();
  useEffect(() => {
    if (animate)
      void branch.start({
        pathLength: 1,
        transition: { duration: 0.6, delay: 0.55 },
      });
  }, [animate, branch]);
  // Thinner strokes at large sizes keep the optical weight constant.
  const strokeWidth =
    size >= 40 ? 1.6 : size >= 28 ? 1.8 : size >= 20 ? 2 : 2.2;
  const path = (delay: number) =>
    animate
      ? {
          variants: draw,
          initial: 'hidden' as const,
          animate: 'shown' as const,
          transition: { duration: 0.6, delay, ease: 'easeOut' as const },
        }
      : {};

  return (
    <motion.svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn('shrink-0', className)}
      onHoverStart={() =>
        animate &&
        void branch.start({
          pathLength: [0, 1],
          transition: { duration: 0.45 },
        })
      }
    >
      <motion.rect x="2.5" y="2.5" width="19" height="19" rx="4" {...path(0)} />
      <motion.circle cx="8.5" cy="8" r="1.9" {...path(0.25)} />
      <motion.circle cx="8.5" cy="16" r="1.9" {...path(0.35)} />
      <motion.path d="M8.5 9.9v4.2" {...path(0.4)} />
      <motion.circle cx="15.5" cy="10" r="1.9" {...path(0.45)} />
      <motion.path
        d="M15.5 11.9v.6a3.5 3.5 0 0 1-3.5 3.5h-1.6"
        initial={animate ? { pathLength: 0 } : false}
        animate={branch}
      />
    </motion.svg>
  );
}

export function Logo({
  size = 22,
  className,
  animate,
  wordmarkClassName,
}: {
  size?: number;
  className?: string;
  animate?: boolean;
  wordmarkClassName?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-ink', className)}>
      <LogoMark size={size} animate={animate} />
      <span
        className={cn('font-semibold tracking-[-0.03em]', wordmarkClassName)}
      >
        gitdesk
      </span>
    </span>
  );
}
