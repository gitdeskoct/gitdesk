import { AnimatePresence, motion } from 'framer-motion';
import { SignInScreen } from '../features/auth/sign-in-screen';
import { WaitingForBrowser } from '../features/auth/waiting-for-browser';
import { AppShell } from '../features/shell/app-shell';
import { TitleBar } from '../features/shell/title-bar';
import { useAuthStatus, useSettings } from '../lib/queries';

// Local Git never depends on the account: the shell opens when signed in, offline, or in local-only mode.
export function App() {
  const auth = useAuthStatus();
  const settings = useSettings();

  if (!auth.data || !settings.data) {
    return (
      <div className="h-full bg-canvas">
        <TitleBar brand={false} sidebarToggle={false} />
      </div>
    );
  }

  const status = auth.data;
  const screen =
    status.status === 'authenticating'
      ? 'waiting'
      : status.status === 'signed-out' && !settings.data.localOnly
        ? 'sign-in'
        : 'shell';

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={screen}
        className="h-full"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
      >
        {screen === 'waiting' && <WaitingForBrowser />}
        {screen === 'sign-in' && status.status === 'signed-out' && (
          <SignInScreen status={status} />
        )}
        {screen === 'shell' && <AppShell status={status} />}
      </motion.div>
    </AnimatePresence>
  );
}
