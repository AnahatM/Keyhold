// SPDX-License-Identifier: GPL-3.0-or-later
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/global.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root element missing from index.html — the renderer cannot mount.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
