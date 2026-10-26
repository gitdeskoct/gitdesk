import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';

// Forge only runs the app in development (`npm start`) and builds main, preload and the renderer
// into .vite/ (`npm run build`). electron-builder.yml makes the installers, fuses and update metadata.
const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'gitdesk',
    executableName: 'gitdesk',
  },
  rebuildConfig: {},
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
  ],
};

export default config;
