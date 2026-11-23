import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import { App } from './App';
import './styles.css';
import { installNativeBehaviour } from './desktop/native';
import { initTheme } from './ui/theme';

// The chosen theme is on <html> before the first paint, so nothing flashes in the other one.
initTheme();
// No browser menus, reload/print keys or navigation: the window is an app, not a tab.
installNativeBehaviour();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
