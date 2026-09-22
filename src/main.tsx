import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app/App';
import { applyTheme, readStoredTheme } from './lib/theme';
import './assets/fonts/fonts.css';
import './styles.css';

// Mark the document hidden while the window is minimized/occluded so CSS can pause all
// looping animations (styles.css) — WebView2 can fall back to software compositing,
// where continuous opacity animations otherwise keep repainting and burn CPU even when
// nobody is looking, and pile up a backlog that re-lags on restore.
const syncHidden = () => {
  document.documentElement.dataset.hidden = document.hidden ? '1' : '0';
};
syncHidden();
document.addEventListener('visibilitychange', syncHidden);

// Apply the persisted theme before first paint so there's no flash of the wrong
// theme (styles.css keys every token off :root[data-theme]). readStoredTheme
// degrades to the dark default in a restricted storage env.
applyTheme(readStoredTheme());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
