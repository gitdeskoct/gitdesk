import type { UpdatesApi, UpdateStatus } from '../../shared/updates';

// The updates bridge for tests that aren't about updates: a development run with nothing to do.
export const devUpdateStatus: UpdateStatus = {
  phase: 'idle',
  installKind: 'dev',
  currentVersion: '1.0.0',
  lastCheck: null,
  releasePage: 'https://github.com/BotCoder254/gitdesk-releases/releases',
};

export const idleUpdates = (
  status: UpdateStatus = devUpdateStatus,
): UpdatesApi => ({
  status: async () => status,
  check: async () => status,
  download: async () => status,
  install: async () => status,
  openReleasePage: async () => {},
  onChanged: () => () => {},
});
