import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { installClientDiagnostics } from './clientDiagnostics';
import './styles.css';
import './journey.css';
import './cinema.css';
import './mapAtlas.css';

installClientDiagnostics();
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
