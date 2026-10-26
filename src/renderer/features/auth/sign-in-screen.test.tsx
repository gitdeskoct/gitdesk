import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthErrorCode, DesktopApi } from '../../../shared/ipc';
import { DEFAULT_SETTINGS } from '../../../shared/settings';
import { NavigationProvider } from '../../app/navigation';
import { ToastProvider } from '../../components/ui/toast';
import { authErrorMessages } from './messages';
import { SignInScreen } from './sign-in-screen';
import { idleUpdates } from '../../test/updates-stub';

const pending = () => new Promise<never>(() => {});

function renderScreen(status: Parameters<typeof SignInScreen>[0]['status']) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(['settings'], DEFAULT_SETTINGS);
  client.setQueryData(['auth'], status);
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <NavigationProvider>
          <SignInScreen status={status} />
        </NavigationProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('SignInScreen', () => {
  let desktop: {
    auth: { signIn: ReturnType<typeof vi.fn> };
    settings: { update: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    desktop = {
      auth: { signIn: vi.fn(pending) },
      settings: {
        update: vi.fn(async (patch) => ({ ...DEFAULT_SETTINGS, ...patch })),
      },
    };
    window.desktop = {
      platform: 'win32',
      updates: idleUpdates(),
      ...desktop,
    } as unknown as DesktopApi;
  });

  it('starts sign-in and shows the pending label while the browser opens', async () => {
    renderScreen({ status: 'signed-out' });
    await userEvent.click(
      screen.getByRole('button', { name: /continue with google/i }),
    );
    expect(desktop.auth.signIn).toHaveBeenCalledOnce();
    const busy = await screen.findByRole('button', {
      name: /opening browser/i,
    });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    // Still focusable while pending, and a second click doesn't start a second flow.
    expect(busy).not.toBeDisabled();
    await userEvent.click(busy);
    expect(desktop.auth.signIn).toHaveBeenCalledOnce();
  });

  it('switches to local-only mode without an account', async () => {
    renderScreen({ status: 'signed-out' });
    await userEvent.click(
      screen.getByRole('button', { name: /continue without an account/i }),
    );
    expect(desktop.settings.update).toHaveBeenCalledWith({ localOnly: true });
  });

  it.each(Object.keys(authErrorMessages) as AuthErrorCode[])(
    'explains the %s error inline',
    (error) => {
      renderScreen({ status: 'signed-out', error });
      expect(
        screen.getByText(authErrorMessages[error].title),
      ).toBeInTheDocument();
    },
  );

  it('shows the session-expired notice', () => {
    renderScreen({ status: 'signed-out', notice: 'session_expired' });
    expect(screen.getByText('Your session expired.')).toBeInTheDocument();
  });
});
