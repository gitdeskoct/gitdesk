import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);
// Whole-app renders share the CPU with the main-process Git tests during a full run.
configure({ asyncUtilTimeout: 3_000 });

// jsdom has no matchMedia; framer-motion's reduced-motion check needs one.
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
