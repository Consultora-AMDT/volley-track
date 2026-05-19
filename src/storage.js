// Tracking local de partidos que el usuario ha abierto (creados o vía link).
// La fuente de verdad sigue siendo Supabase; esto solo recuerda en qué partidos
// ha participado este dispositivo para mostrarlos en "Mis partidos".

const KEY = 'volley:visited_matches';
const MAX = 50;

export function trackVisited(matchId) {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    const filtered = list.filter((x) => x !== matchId);
    filtered.unshift(matchId);
    localStorage.setItem(KEY, JSON.stringify(filtered.slice(0, MAX)));
  } catch {
    /* localStorage no disponible */
  }
}

export function getVisitedIds() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function forgetVisited(matchId) {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    localStorage.setItem(KEY, JSON.stringify(list.filter((x) => x !== matchId)));
  } catch {}
}

// Memoria de la versión de la app que el usuario tenía la última vez que
// abrió la PWA en este dispositivo. Se usa para detectar saltos de versión
// (es decir, "la app se acaba de actualizar") y mostrar un aviso en
// la primera apertura tras un update.
const VERSION_KEY = 'volley:last_seen_version';

export function getLastSeenVersion() {
  try {
    return localStorage.getItem(VERSION_KEY) || null;
  } catch {
    return null;
  }
}

export function setLastSeenVersion(version) {
  try {
    localStorage.setItem(VERSION_KEY, String(version));
  } catch {}
}
