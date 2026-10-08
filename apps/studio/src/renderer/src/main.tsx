import { TooltipProvider } from '@autoflow/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { RunBar } from './components/RunBar';
import './styles.css';

// The same page also serves the floating test-run bar (main/runguard.ts): index.html?view=runbar
const view = new URLSearchParams(window.location.search).get('view');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>{view === 'runbar' ? <RunBar /> : <App />}</TooltipProvider>
  </StrictMode>,
);
