import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// StrictMode on purpose: it mounts every effect twice in development, which
// is exactly the case a one-shot transferControlToOffscreen() has to survive.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
