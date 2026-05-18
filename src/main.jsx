import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.jsx';
import './index.css';

// Registro manual del SW para tener control sobre la actualización.
// onNeedRefresh se dispara cuando hay una versión nueva esperando: recargamos
// la página silenciosamente. Con skipWaiting+clientsClaim el SW nuevo ya tomó
// el control, así que el reload garantiza que el usuario carga el bundle nuevo.
// onOfflineReady simplemente avisa internamente.
const updateSW = registerSW({
  onNeedRefresh() {
    // Recargar tras un pequeño delay para no interrumpir un tap en marcha.
    setTimeout(() => {
      updateSW(true);
      window.location.reload();
    }, 1500);
  },
  onOfflineReady() {
    // VolleyTrack está listo offline (no hacemos nada visible).
  },
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
