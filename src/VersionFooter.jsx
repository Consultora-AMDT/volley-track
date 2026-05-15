import React from 'react';
import { APP_VERSION } from './config.js';

// __BUILD_COMMIT__ y __BUILD_DATE__ se inyectan vía vite.config.js define
const COMMIT = typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev';
const BUILD_DATE = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : new Date().toISOString();

export function VersionFooter() {
  const d = new Date(BUILD_DATE);
  const date = d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: '2-digit' });
  const time = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="text-center text-[14px] text-slate-300 pt-3 pb-2 font-mono select-text">
      v{APP_VERSION} · {COMMIT} · {date} {time}
    </div>
  );
}
