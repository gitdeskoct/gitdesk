import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from '@tanstack/react-query';
import { MotionConfig } from 'framer-motion';
import { useEffect, useState, type ReactNode } from 'react';
import { TooltipProvider } from '../components/ui/tooltip';
import { keys, useSettings } from '../lib/queries';
import { NavigationProvider } from './navigation';
import { useAppearance } from './use-appearance';

function AuthSync() {
  const qc = useQueryClient();
  useEffect(
    () =>
      window.desktop.auth.onStatusChanged((status) => {
        qc.setQueryData(keys.auth, status);
        if (status.status !== 'authenticated')
          qc.removeQueries({ queryKey: keys.sessions });
      }),
    [qc],
  );
  return null;
}

function Appearance({ children }: { children: ReactNode }) {
  const { data: settings } = useSettings();
  useAppearance(settings);
  const motion = settings?.motion ?? 'full';
  return (
    <MotionConfig
      reducedMotion={motion === 'full' ? 'user' : 'always'}
      transition={motion === 'off' ? { duration: 0 } : undefined}
    >
      {children}
    </MotionConfig>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  // IPC calls are local and either succeed or fail for a reason a retry won't fix.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <AuthSync />
      <Appearance>
        <TooltipProvider delayDuration={300}>
          <NavigationProvider>{children}</NavigationProvider>
        </TooltipProvider>
      </Appearance>
    </QueryClientProvider>
  );
}
