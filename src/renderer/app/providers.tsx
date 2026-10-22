import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from '@tanstack/react-query';
import { MotionConfig } from 'framer-motion';
import { useEffect, useState, type ReactNode } from 'react';
import { ToastProvider, useToast } from '../components/ui/toast';
import { TooltipProvider } from '../components/ui/tooltip';
import { keys, repoKeys, useSettings } from '../lib/queries';
import { NavigationProvider, useNavigation } from './navigation';
import { useAppearance } from './use-appearance';
import { WorkspaceUiProvider } from './workspace-ui';

function AuthSync() {
  const qc = useQueryClient();
  useEffect(
    () =>
      window.desktop.auth.onStatusChanged((status) => {
        qc.setQueryData(keys.auth, status);
        if (status.status !== 'authenticated')
          qc.removeQueries({ queryKey: keys.sessions });
        // Main decides whether this actually reaches the server; usually it answers from cache.
        void qc.invalidateQueries({ queryKey: repoKeys.remote });
      }),
    [qc],
  );
  return null;
}

// Main pushes the whole list after every inspection burst, so nothing here polls.
function RepoSync() {
  const qc = useQueryClient();
  useEffect(
    () =>
      window.desktop.repos.onChanged((repositories) => {
        qc.setQueryData(repoKeys.list, repositories);
        void qc.invalidateQueries({ queryKey: repoKeys.activity });
      }),
    [qc],
  );
  return null;
}

// News from main while the window is in front becomes a toast; a clicked system notification
// opens its repository. The id is only used as a route key; the page looks it up itself.
function NoticeSync() {
  const toast = useToast();
  const { navigate } = useNavigation();
  useEffect(() => {
    const offNotice = window.desktop.app.onNotice((notice) =>
      toast({
        title: notice.title,
        description: notice.body,
        tone: notice.tone,
        background: true,
        action: notice.repositoryId
          ? {
              label: 'Open',
              altText: 'Open the repository from Home or Repositories',
              onClick: () =>
                navigate({ name: 'repository', id: notice.repositoryId! }),
            }
          : undefined,
      }),
    );
    const offOpen = window.desktop.app.onOpenRepository((id) => {
      if (/^[0-9a-f-]{36}$/i.test(id)) navigate({ name: 'repository', id });
    });
    return () => {
      offNotice();
      offOpen();
    };
  }, [toast, navigate]);
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
      <RepoSync />
      <Appearance>
        <TooltipProvider delayDuration={300}>
          <ToastProvider>
            <NavigationProvider>
              <NoticeSync />
              <WorkspaceUiProvider>{children}</WorkspaceUiProvider>
            </NavigationProvider>
          </ToastProvider>
        </TooltipProvider>
      </Appearance>
    </QueryClientProvider>
  );
}
