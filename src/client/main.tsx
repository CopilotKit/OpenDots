import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installReconnect } from './reconnect';
import './style.css';
import './editor.css';
installReconnect();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
