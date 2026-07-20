import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
