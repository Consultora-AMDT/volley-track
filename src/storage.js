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
