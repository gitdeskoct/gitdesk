import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { Providers } from './app/providers';
import { applyTheme, systemTheme } from './app/use-appearance';
import './styles/globals.css';

// Before the first render, so nothing paints in the wrong palette while settings load.
applyTheme(systemTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);
