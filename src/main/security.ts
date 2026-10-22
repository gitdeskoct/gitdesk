import { app, session } from 'electron';
import { CSP } from './protocol';
import { isAllowedPermission, isAllowedRendererUrl } from './config';

// Vite's dev server needs inline scripts for the React refresh preamble and a websocket for HMR.
const DEV_CSP = CSP.replace(
  "script-src 'self'",
  "script-src 'self' 'unsafe-inline'",
)
  .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
  .replace("connect-src 'self'", "connect-src 'self' ws://localhost:*");

export function hardenApp(
  origins: string[],
  devServerUrl: string | undefined,
): void {
  app.on('web-contents-created', (_event, contents) => {
    const guard = (event: Electron.Event, url: string) => {
      if (!isAllowedRendererUrl(url, origins)) event.preventDefault();
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(
      isAllowedPermission(
        permission,
        details.requestingUrl ?? contents.getURL(),
        origins,
      ),
    ),
  );
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    isAllowedPermission(permission, requestingOrigin, origins),
  );

  if (devServerUrl) {
    const devOrigin = new URL(devServerUrl).origin;
    ses.webRequest.onHeadersReceived(
      { urls: [`${devOrigin}/*`] },
      (details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [DEV_CSP],
          },
        });
      },
    );
  }
}
