/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />

interface ImportMetaEnv {
  readonly VITE_API_ORIGIN?: string;
}

interface Window {
  desktop: import('./shared/ipc').DesktopApi;
}
