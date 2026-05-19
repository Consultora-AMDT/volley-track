import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import {
  Trophy, Users, RotateCw, Plus, Minus, ChevronLeft, Home, History, Play,
  Wifi, WifiOff, AlertTriangle, Edit3, Check, X, CheckCircle2, Clock, Trash2,
  Share2, Copy,
} from 'lucide-react';
import {
  isConfigured, ensureAuth, onAuthChange,
  createMatch, getMatch, listMatchesByIds,
  addPoint as apiAddPoint, undoPoint as apiUndoPoint, subtractPoint as apiSubtractPoint,
  rotatePositions, updateLineup, updateRoster, finishMatch, reopenMatch, deleteMatch,
  subscribeToMatch,
} from './api.js';
import { trackVisited, getVisitedIds, forgetVisited, getLastSeenVersion, setLastSeenVersion } from './storage.js';
import { LIMITS, SANTA_ANA_ROSTER, APP_VERSION, STALE_MATCH_MINUTES } from './config.js';
import { FeedbackButton } from './FeedbackButton.jsx';
import { ShareButton } from './ShareButton.jsx';
import { VersionFooter } from './VersionFooter.jsx';

// Etiquetas de las 4 posiciones (P1=índice 0, P2=índice 1, etc.)
const POSITION_LABELS = ['Saque', 'Izquierda', 'Colocador/a', 'Derecha'];
const POSITION_SHORT = ['P1', 'P2', 'P3', 'P4'];

// Desactivamos la restauración automática de scroll del navegador a nivel
// de módulo (antes de que React monte). Sin esto, al pulsar el botón
// "atrás" del móvil el browser restaura la posición de scroll de la
// pantalla anterior ANTES de que dispararse hashchange, y nuestro
// scrollTo(0,0) llega tarde — el usuario ve la pantalla con scroll
// heredado durante un instante o de forma permanente según el navegador.
if (typeof window !== 'undefined' && 'scrollRestoration' in window.history) {
  window.history.scrollRestoration = 'manual';
}

// ============ ROUTER (hash) ============
function parseHash() {
  const h = window.location.hash || '';
  const m = h.match(/^#\/match\/([0-9a-f-]{36})$/i);
  if (m) return { view: 'match', id: m[1] };
  if (h === '#/setup') return { view: 'setup' };
  if (h === '#/history') return { view: 'history' };
  return { view: 'home' };
}
// El parámetro opcional `replace` reemplaza la entrada actual del historial
// en lugar de añadir una nueva. Útil cuando una pantalla es un paso
// intermedio que no debe revisitarse con el botón atrás del móvil (caso
// típico: el formulario de "Nuevo partido" tras crear el partido — no
// tiene sentido que el atrás desde el marcador vuelva al formulario).
// Usamos history.replaceState y disparamos hashchange manualmente porque
// replaceState no lo lanza por sí mismo.
const navigate = (h, opts = {}) => {
  // Forzamos el scroll al top antes de cambiar la ruta para evitar que la
  // siguiente pantalla aparezca con el scroll heredado de la anterior
  // (causa raíz del "marcador cortado" al venir del formulario).
  if (typeof window !== 'undefined') {
    try {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    } catch {}
  }
  if (opts.replace) {
    const url = window.location.pathname + window.location.search + h;
    window.history.replaceState(null, '', url);
    window.dispatchEvent(new Event('hashchange'));
  } else {
    window.location.hash = h;
  }
};

// ============ HELPERS TIEMPO ============
const formatHHMM = (ts) => new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  // Padding a 2 dígitos para minutos y segundos cuando hay horas, o
  // segundos cuando hay minutos. Así se lee como un cronómetro.
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    // Cada segundo para que el cronómetro muestre los segundos vivos.
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

// Detecta rotación cíclica horaria con 4 jugadores/as:
//   prev = [P1, P2, P3, P4]  ->  curr = [P4, P1, P2, P3]
function isCyclicRotation(prev, curr) {
  if (!prev || !curr || prev.length !== 4 || curr.length !== 4) return false;
  return curr[0].name === prev[3].name
      && curr[1].name === prev[0].name
      && curr[2].name === prev[1].name
      && curr[3].name === prev[2].name;
}

// Defensa en la UI contra el bug de "set duplicado" (v1.4.3): si el array
// sets[] contiene varias entradas con el mismo number (típicamente por
// reopens antiguos antes del fix del RPC), nos quedamos con la última
// entrada de cada número y ordenamos ascendentemente. Esto es solo cosmético
// — el dato real en la BD se limpia con dedupeMatchSets / la migración SQL.
function uniqueSetsByNumber(sets) {
  if (!Array.isArray(sets) || sets.length === 0) return [];
  const byNumber = new Map();
  for (const s of sets) {
    if (s && s.number != null) byNumber.set(s.number, s);
  }
  return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
}

// ============ APP ============
export default function App() {
  const [route, setRoute] = useState(parseHash());
  const [userId, setUserId] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [online, setOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  // Si la versión guardada en localStorage es distinta a APP_VERSION, este
  // state contiene la versión anterior (string). Mostramos un modal de
  // bienvenida "App actualizada" hasta que el usuario lo cierra con OK.
  // null = no hay actualización pendiente que notificar.
  const [updatedFromVersion, setUpdatedFromVersion] = useState(null);

  // Detección de actualización: compara la versión guardada con la actual.
  // - Primera ejecución (nada guardado): registramos APP_VERSION
  //   silenciosamente. No es una "actualización", es alguien que abre
  //   la app por primera vez.
  // - Versión guardada == APP_VERSION: nada que hacer.
  // - Versión guardada != APP_VERSION: muestra el modal y actualiza la
  //   versión guardada cuando el usuario pulsa OK.
  useEffect(() => {
    const last = getLastSeenVersion();
    if (last && last !== APP_VERSION) {
      setUpdatedFromVersion(last);
    } else if (!last) {
      setLastSeenVersion(APP_VERSION);
    }
  }, []);

  const dismissUpdateModal = () => {
    setLastSeenVersion(APP_VERSION);
    setUpdatedFromVersion(null);
  };

  useEffect(() => {
    // Helper: scroll a top, robusto frente a las distintas APIs del browser.
    const scrollTop = () => {
      if (typeof window === 'undefined') return;
      try {
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      } catch {}
    };
    // hashchange se dispara en navegaciones forward y en programáticas.
    // popstate se dispara cuando el usuario pulsa el botón "atrás" del
    // móvil (browser back). Ambos llevan a re-parsear la ruta y resetear
    // el scroll, así escuchamos los dos para cubrir todas las navegaciones.
    const onRoute = () => {
      setRoute(parseHash());
      // Scroll inmediato (síncrono) + diferido (tras el paint, por si el
      // navegador restaura el scroll de cache después del evento).
      scrollTop();
      requestAnimationFrame(scrollTop);
      setTimeout(scrollTop, 50);
    };
    window.addEventListener('hashchange', onRoute);
    window.addEventListener('popstate', onRoute);
    // Re-aseguramos scrollRestoration manual (por si algo lo restauró).
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
    return () => {
      window.removeEventListener('hashchange', onRoute);
      window.removeEventListener('popstate', onRoute);
    };
  }, []);

  useEffect(() => {
    const on = () => setOnline(true); const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  useEffect(() => {
    if (!isConfigured) return;
    ensureAuth().then(setUserId).catch((e) => setAuthError(e.message));
    return onAuthChange((uid) => setUserId(uid));
  }, []);

  if (!isConfigured) return <ConfigError />;
  if (authError) return <FullScreenError title="No se puede iniciar sesión" detail={authError} />;
  if (!userId) return <FullScreen>Conectando…</FullScreen>;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 pb-10 max-w-md mx-auto relative">
      {!online && <OfflineBanner />}
      <div className="animate-in">
        {route.view === 'home' && <HomeView userId={userId} />}
        {route.view === 'setup' && <SetupView userId={userId} />}
        {route.view === 'match' && <MatchView matchId={route.id} userId={userId} />}
        {route.view === 'history' && <HistoryView userId={userId} />}
      </div>
      {updatedFromVersion && (
        <UpdateModal fromVersion={updatedFromVersion} toVersion={APP_VERSION} onClose={dismissUpdateModal} />
      )}
    </div>
  );
}

// Modal de bienvenida tras actualizar la app. Aparece la primera vez que
// el usuario abre la PWA después de un upgrade del service worker. Se
// cierra solo con el botón OK (no se cierra tocando fuera) para garantizar
// que el usuario lo vea — algunos avisos son importantes (cambios de
// regla, fixes que requieren su atención) y no queremos que se pase
// de largo accidentalmente.
function UpdateModal({ fromVersion, toVersion, onClose }) {
  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in">
      <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-card-lg animate-in-pop text-center">
        <div className="w-14 h-14 rounded-full bg-brand-green-soft flex items-center justify-center mx-auto mb-3">
          <CheckCircle2 size={32} className="text-brand-green" />
        </div>
        <h3 className="text-xl font-bold text-slate-900 mb-1">¡App actualizada!</h3>
        <p className="text-[14px] text-slate-600 mb-4">
          Ya tienes la última versión con las mejoras y correcciones.
        </p>
        <div className="mb-5 p-3 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-center gap-2 text-sm font-mono">
          <span className="text-slate-400">v{fromVersion}</span>
          <span className="text-slate-300">→</span>
          <span className="text-brand-green font-bold">v{toVersion}</span>
        </div>
        <button
          onClick={onClose}
          className="w-full p-3.5 bg-gradient-to-br from-brand-green to-brand-green-dark text-white rounded-2xl font-bold text-base shadow-card active:scale-[0.98] transition"
        >
          OK
        </button>
      </div>
    </div>
  );
}

// ============ HELPERS UI ============
function FullScreen({ children }) {
  return <div className="min-h-screen bg-slate-50 flex items-center justify-center text-slate-500 px-6 text-center">{children}</div>;
}
function FullScreenError({ title, detail }) {
  return <FullScreen>
    <div><AlertTriangle className="mx-auto mb-3 text-red-500" size={32} />
      <div className="font-semibold text-slate-900 mb-1">{title}</div>
      <div className="text-sm text-slate-500">{detail}</div>
    </div>
  </FullScreen>;
}
function ConfigError() {
  return <FullScreen>
    <div><AlertTriangle className="mx-auto mb-3 text-brand-green" size={32} />
      <div className="font-semibold text-slate-900 mb-1">Falta configurar Supabase</div>
      <div className="text-sm text-slate-500">
        Define <code className="text-brand-green">VITE_SUPABASE_URL</code> y <code className="text-brand-green">VITE_SUPABASE_ANON_KEY</code> en <code>.env</code>. Mira el README.
      </div>
    </div>
  </FullScreen>;
}
function OfflineBanner() {
  return <div className="bg-amber-100 border-b border-amber-200 text-amber-800 text-xs px-4 py-2 flex items-center gap-2 justify-center font-medium">
    <WifiOff size={14} /> Sin conexión — los cambios no se sincronizarán
  </div>;
}

// ============ TOAST ============
// El campo `highlight` muestra un texto destacado a tamaño mayor justo debajo
// de `message`, con todo el contenido centrado. Útil para anunciar acciones
// como "↻ Rotación aplicada" + "Saca Paula H #3" donde el nombre del jugador
// merece más visibilidad.
function Toast({ message, highlight, kind = 'info', onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 3000); return () => clearTimeout(t); }, [onClose]);
  const styles = kind === 'warn' ? 'bg-amber-50 border-amber-200 text-amber-900'
               : kind === 'error' ? 'bg-red-50 border-red-200 text-red-900'
               : kind === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
               : 'bg-white border-slate-200 text-slate-900';
  const Icon = kind === 'success' ? CheckCircle2 : AlertTriangle;
  if (highlight) {
    return (
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-md w-full px-4 animate-in">
        <div className={`relative p-3 pr-9 rounded-2xl border shadow-card-md text-sm ${styles}`}>
          <div className="flex flex-col items-center gap-1 text-center">
            <div className="flex items-center gap-2 font-medium">
              <Icon size={16} /> <span>{message}</span>
            </div>
            <div className="text-base font-bold leading-tight">{highlight}</div>
          </div>
          <button onClick={onClose} className="absolute top-3 right-3 opacity-50">
            <X size={14} />
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-md w-full px-4 animate-in">
      <div className={`p-3 rounded-2xl border shadow-card-md text-sm flex items-center gap-2 ${styles}`}>
        <Icon size={16} /> <span className="flex-1 font-medium">{message}</span>
        <button onClick={onClose} className="opacity-50"><X size={14} /></button>
      </div>
    </div>
  );
}

// ============ HOME ============
function HomeView({ userId }) {
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(null); // {match}
  const [toast, setToast] = useState(null);

  useEffect(() => {
    (async () => {
      let list = await listMatchesByIds(getVisitedIds());

      // Auto-cierre de partidos abandonados. Criterio: !finished y updated_at
      // mas antiguo que STALE_MATCH_MINUTES. Los partidos abandonados son un
      // problema porque la regla "solo un partido en vivo a la vez" impide
      // crear uno nuevo hasta que se cierren. Asi se cierran solos al abrir
      // la app, sin requerir intervencion del usuario ni cron en backend.
      try {
        const cutoff = Date.now() - STALE_MATCH_MINUTES * 60 * 1000;
        const stale = list.filter((m) => !m.finished && m.updatedAt < cutoff);
        if (stale.length > 0) {
          const closedNames = [];
          for (const m of stale) {
            try {
              const closed = await finishMatch(m.id);
              const idx = list.findIndex((x) => x.id === m.id);
              if (idx >= 0) list[idx] = closed;
              closedNames.push(`${m.teamA} vs ${m.teamB}`);
            } catch (e) {
              console.error('No se pudo auto-cerrar partido', m.id, e);
            }
          }
          if (closedNames.length > 0) {
            const msg = closedNames.length === 1
              ? `"${closedNames[0]}" se cerró por inactividad (${STALE_MATCH_MINUTES} min sin actividad)`
              : `${closedNames.length} partidos cerrados por inactividad`;
            setToast({ key: Date.now(), kind: 'info', message: msg, highlight: 'Auto-cierre' });
          }
        }
      } catch (e) {
        console.error('Error en auto-cierre de partidos', e);
      }

      setMatches(list);
      setLoading(false);
    })();
  }, [userId]);

  const handleDelete = async () => {
    if (!confirmDelete) return;
    const match = confirmDelete.match;
    const isOwner = match.createdBy === userId;
    setConfirmDelete(null);
    try {
      if (isOwner) {
        await deleteMatch(match.id);
      }
      forgetVisited(match.id);
      setMatches((prev) => prev.filter((m) => m.id !== match.id));
      setToast({ message: isOwner ? 'Partido eliminado' : 'Partido quitado de tu lista', kind: 'success', key: Date.now() });
    } catch (e) {
      console.error(e);
      setToast({ message: 'No se pudo eliminar', kind: 'error', key: Date.now() });
    }
  };

  const inProgress = matches.find((m) => !m.finished);
  const finished = matches.filter((m) => m.finished);

  return (
    <div className="px-5 pt-10 pb-6">
      {/* Header con logo */}
      <div className="flex items-center justify-between mb-2">
        <img src="/school-logo.png" alt="Santa Ana y San Rafael" className="h-12 w-auto" />
        <span className="text-[15px] uppercase tracking-widest text-slate-400 font-semibold">VolleyTrack</span>
      </div>

      <h1 className="text-3xl font-bold mt-6 mb-1 text-slate-900">Hola 👋</h1>
      <p className="text-slate-500 mb-8">Sigue los partidos de voleibol del cole en directo.</p>

      {inProgress && (
        <button
          onClick={() => navigate(`#/match/${inProgress.id}`)}
          className="w-full mb-3 p-4 bg-gradient-to-r from-brand-green to-brand-green-dark text-white rounded-2xl font-semibold flex items-center justify-between shadow-card-md transition"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
              <Play size={18} fill="white" />
            </div>
            <div className="text-left">
              <div className="text-sm opacity-80">EN VIVO</div>
              <div className="font-bold">{inProgress.teamA} vs {inProgress.teamB}</div>
            </div>
          </div>
          <div className="text-2xl font-bold pulse-live">●</div>
        </button>
      )}

      {/* "Nuevo partido": cuando ya hay un partido en vivo el botón se
          deshabilita para evitar que se creen partidos duplicados sin
          querer (caso típico: dos padres/madres crean en paralelo y se
          quedan dos partidos a la vez en el mismo evento). El usuario
          tiene que entrar al partido en vivo y finalizarlo (o
          eliminarlo) antes de poder crear uno nuevo. */}
      {inProgress ? (
        <button
          onClick={() => setToast({
            message: `Termina primero "${inProgress.teamA} vs ${inProgress.teamB}"`,
            kind: 'warn',
            key: Date.now(),
          })}
          className="w-full mb-3 p-5 bg-slate-100 border border-slate-200 rounded-2xl flex items-center justify-between cursor-not-allowed"
          aria-disabled="true"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-slate-200 flex items-center justify-center flex-shrink-0">
              <Plus size={22} className="text-slate-400" />
            </div>
            <div className="text-left min-w-0">
              <div className="text-base text-slate-400 font-semibold">Nuevo partido</div>
              <div className="text-xs text-slate-500 font-normal truncate">Finaliza el partido en vivo primero</div>
            </div>
          </div>
          <AlertTriangle size={18} className="text-amber-500 flex-shrink-0 ml-2" />
        </button>
      ) : (
        <button
          onClick={() => navigate('#/setup')}
          className="w-full mb-3 p-5 bg-white rounded-2xl font-semibold flex items-center justify-between transition border border-slate-200 shadow-card hover:shadow-card-md"
        >
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-brand-green-soft flex items-center justify-center">
              <Plus size={22} className="text-brand-green" />
            </div>
            <span className="text-base text-slate-900">Nuevo partido</span>
          </div>
          <ChevronLeft className="rotate-180 text-slate-400" size={18} />
        </button>
      )}

      <button
        onClick={() => navigate('#/history')}
        className="w-full p-5 bg-white rounded-2xl font-semibold flex items-center justify-between transition border border-slate-200 shadow-card hover:shadow-card-md"
      >
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-brand-green-soft flex items-center justify-center">
            <History size={22} className="text-brand-green-dark" />
          </div>
          <div className="text-left">
            <div className="text-base text-slate-900">Mis partidos</div>
            <div className="text-xs text-slate-500 font-normal">Guardados para consultar</div>
          </div>
        </div>
        <div className="bg-slate-100 rounded-full px-2.5 py-1 text-sm text-slate-600 font-bold">
          {matches.length}
        </div>
      </button>

      <div className="mt-6 p-4 bg-brand-green-soft/60 rounded-2xl border border-brand-green/10">
        <p className="text-xs text-slate-700 leading-relaxed">
          <strong className="text-brand-green-dark">¿Te han pasado un enlace?</strong> Ábrelo y el partido aparecerá aquí; podrás sumar puntos junto al resto del grupo.
        </p>
      </div>

      {!loading && finished.length > 0 && (
        <div className="mt-8">
          <h2 className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-3">Recientes</h2>
          {finished.slice(0, 3).map((m) => (
            <MatchCard
              key={m.id} match={m} userId={userId}
              onClick={() => navigate(`#/match/${m.id}`)}
              onDelete={(match) => setConfirmDelete({ match })}
            />
          ))}
        </div>
      )}

      <FeedbackButton />
      <VersionFooter />

      {toast && <Toast key={toast.key} message={toast.message} highlight={toast.highlight} kind={toast.kind} onClose={() => setToast(null)} />}

      {confirmDelete && (
        <ConfirmModal
          title="¿Eliminar este partido?"
          message={
            confirmDelete.match.createdBy === userId
              ? 'Tú creaste este partido. Se borrará del servidor y desaparecerá también para el resto de padres/madres que tengan el enlace. No se puede deshacer.'
              : 'Lo quitará solo de tu lista. El partido seguirá existiendo para los/las demás y para quien lo creó.'
          }
          confirmText="Sí, eliminar"
          variant="danger"
          onConfirm={handleDelete}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

// Detecta si el nombre de un equipo es el Santa Ana / San Rafael. Acepta
// variantes y abreviaturas comunes que escriben los padres/madres:
// "Santa Ana", "Sta Ana", "Sta. Ana", "San Rafael", "S. Rafael",
// "Colegio Santa Ana y San Rafael", o bien "SA"/"SR" como código exacto.
function isSantaAnaName(name) {
  if (!name) return false;
  const n = name.toLowerCase().trim();
  if (n === 'sa' || n === 'sr') return true;
  // \b delimita la frontera de palabra para no hacer match con "santana"
  // (pegado, otro contexto). Acepta espacio o sin espacio entre Sta/S y
  // el resto, con punto opcional tras la abreviatura.
  return /\b(santa\s*ana|sta\.?\s*ana|san\s*rafael|s\.?\s*rafael)\b/.test(n);
}

// Asigna colores a los dos equipos del partido. El cole (Santa Ana o
// San Rafael) siempre va en VERDE; el rival siempre va en AZUL. Si por
// algún motivo ninguno encaja con el cole (o lo hacen ambos), caemos
// al esquema anterior (verde claro / verde oscuro) para que la UI no
// quede plana.
//   Returns: [colorA, colorB] con valores 'green' | 'blue' | 'green-dark'.
function teamColorPair(teamA, teamB) {
  const aIsSantaAna = isSantaAnaName(teamA);
  const bIsSantaAna = isSantaAnaName(teamB);
  if (aIsSantaAna && !bIsSantaAna) return ['green', 'blue'];
  if (bIsSantaAna && !aIsSantaAna) return ['blue', 'green'];
  return ['green', 'green-dark'];
}

// Devuelve las clases Tailwind concretas asociadas a un color de equipo.
// Centraliza el mapping color → clases para que TeamHeader, ScoreButton,
// CourtCell y FinishedSummary compartan la misma paleta sin repetir
// strings hardcodeados (que además romperían el JIT de Tailwind si se
// construyen dinámicamente).
function colorTokens(color) {
  if (color === 'blue') {
    return {
      text: 'text-brand-blue',
      textDark: 'text-brand-blue-dark',
      bgSoft: 'bg-brand-blue-soft',
      gradient: 'bg-gradient-to-br from-brand-blue to-brand-blue-dark',
      gradientSoft: 'bg-gradient-to-b from-brand-blue-soft/40 to-transparent',
      activeFrom: 'active:from-brand-blue',
      activeTo: 'active:to-brand-blue-dark',
      border: 'border-brand-blue/20',
    };
  }
  if (color === 'green-dark') {
    // Fallback: equipo visitante cuando ninguno es el cole. Tono verde
    // oscuro para diferenciar visualmente del local sin salir de la
    // paleta del cole.
    return {
      text: 'text-brand-green-dark',
      textDark: 'text-brand-green-dark',
      bgSoft: 'bg-emerald-50',
      gradient: 'bg-gradient-to-br from-brand-green-dark to-brand-green',
      gradientSoft: 'bg-gradient-to-b from-emerald-50/60 to-transparent',
      activeFrom: 'active:from-brand-green-dark',
      activeTo: 'active:to-brand-green',
      border: 'border-brand-green/20',
    };
  }
  // 'green' por defecto: equipo del cole (Santa Ana / San Rafael).
  return {
    text: 'text-brand-green',
    textDark: 'text-brand-green-dark',
    bgSoft: 'bg-brand-green-soft',
    gradient: 'bg-gradient-to-br from-brand-green to-brand-green-dark',
    gradientSoft: 'bg-gradient-to-b from-brand-green-soft/40 to-transparent',
    activeFrom: 'active:from-brand-green',
    activeTo: 'active:to-brand-green-dark',
    border: 'border-brand-green/20',
  };
}

function MatchCard({ match, userId, onClick, onDelete }) {
  const sets = uniqueSetsByNumber(match.sets);
  const setsA = sets.filter((s) => s.a > s.b).length;
  const setsB = sets.filter((s) => s.b > s.a).length;
  // Derivamos el ganador del marcador si match.winner está en null. Caso
  // típico: partido finalizado manualmente sin haber alcanzado sets_needed.
  // Solo consideramos derivedWinner cuando el partido ya está finalizado
  // (para EN VIVO no marcamos un ganador hasta que la BD lo confirme).
  let derivedWinner = match.winner;
  if (!derivedWinner && match.finished) {
    if (setsA > setsB) derivedWinner = 'A';
    else if (setsB > setsA) derivedWinner = 'B';
  }
  const wonA = derivedWinner === 'A';
  const wonB = derivedWinner === 'B';
  // Victoria del Santa Ana (cole).
  const santaAnaWon =
    (wonA && isSantaAnaName(match.teamA)) ||
    (wonB && isSantaAnaName(match.teamB));
  // Colores base de cada equipo (verde = cole, azul = rival).
  const [colorA, colorB] = teamColorPair(match.teamA, match.teamB);
  const ta = colorTokens(colorA);
  const tb = colorTokens(colorB);
  return (
    <div className={`w-full rounded-2xl mb-2 shadow-card hover:shadow-card-md transition flex items-stretch ${santaAnaWon ? 'bg-gradient-to-br from-amber-50 to-yellow-50 border-2 border-amber-300' : 'bg-white border border-slate-200'}`}>
      <button onClick={onClick} className="flex-1 text-left p-4 min-w-0">
        <div className="flex items-center justify-between mb-1.5 gap-2">
          <span className={`font-semibold truncate flex items-center gap-1.5 ${wonA ? (santaAnaWon ? 'text-amber-800' : ta.text) : 'text-slate-900'}`}>
            {wonA && santaAnaWon && <Trophy size={16} className="text-amber-500 flex-shrink-0" />}
            <span className="truncate">{match.teamA}</span>
          </span>
          <span className={`font-bold text-xl tabular-nums flex-shrink-0 ${wonA ? (santaAnaWon ? 'text-amber-800' : ta.text) : 'text-slate-400'}`}>{setsA}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className={`truncate flex items-center gap-1.5 ${wonB ? (santaAnaWon ? 'text-amber-800 font-semibold' : `${tb.text} font-semibold`) : 'text-slate-700'}`}>
            {wonB && santaAnaWon && <Trophy size={16} className="text-amber-500 flex-shrink-0" />}
            <span className="truncate">{match.teamB}</span>
          </span>
          <span className={`font-bold text-xl tabular-nums flex-shrink-0 ${wonB ? (santaAnaWon ? 'text-amber-800' : tb.text) : 'text-slate-400'}`}>{setsB}</span>
        </div>
        <div className="text-xs text-slate-500 mt-2 flex items-center gap-2 font-normal flex-wrap">
          {new Date(match.startedAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}
          {!match.finished && (
            <span className="text-red-500 font-semibold flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-red-500 rounded-full pulse-live" /> EN VIVO
            </span>
          )}
          {santaAnaWon && (
            <span className="text-amber-700 font-bold tracking-wide">¡VICTORIA!</span>
          )}
          {match.location && <span className="text-slate-400 truncate">· {match.location}</span>}
        </div>
      </button>
      {onDelete && (
        <button
          onClick={() => onDelete(match)}
          aria-label="Eliminar partido"
          className="flex-shrink-0 px-3 my-3 mr-2 ml-1 border-l border-slate-100 text-red-500 hover:text-red-600 hover:bg-red-50 rounded-xl transition flex items-center justify-center"
        >
          <Trash2 size={16} />
        </button>
      )}
    </div>
  );
}

// ============ SETUP ============
function SetupView({ userId }) {
  const [teamA, setTeamA] = useState('');
  const [teamB, setTeamB] = useState('');
  const [format, setFormat] = useState('bo3'); // BO3 por defecto (infantil)
  const [location, setLocation] = useState('');
  const [firstServe, setFirstServe] = useState('A');
  // 4 titulares + suplentes: cada uno {name, number?}
  const [starters, setStarters] = useState([
    { name: '', number: null }, { name: '', number: null },
    { name: '', number: null }, { name: '', number: null },
  ]);
  const [bench, setBench] = useState([]); // array de {name, number?}
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [picker, setPicker] = useState(null); // {scope: 'starter'|'bench', idx} para elegir de plantilla

  // Guard: si el usuario ya tiene un partido EN VIVO entre sus visitados,
  // no debería estar aquí. Esto cubre el caso de que llegue al SetupView
  // por gesto atrás del móvil o por link directo (en HomeView ya se
  // bloquea el botón "Nuevo partido"). Al detectarlo, redirige a Inicio
  // mostrando un aviso. La comprobación es asíncrona y silenciosa: si
  // todo va bien, no se ve nada en pantalla.
  useEffect(() => {
    let cancelled = false;
    listMatchesByIds(getVisitedIds()).then((matches) => {
      if (cancelled) return;
      const live = matches.find((m) => !m.finished);
      if (live) {
        // Pequeño delay para que la transición de pantalla no sea brusca
        // y para que el toast llegue tras montarse la HomeView.
        setTimeout(() => navigate(''), 50);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const canStart = teamA.trim() && teamB.trim() && !creating;
  // La plantilla del cole está SIEMPRE activa (esta app es del Santa Ana).
  // Los slots de titular y banquillo se muestran como selectores que abren
  // el RosterPickerModal con la lista de jugadores/as.
  const rosterLoaded = true;

  // Devuelve las jugadores/as de la plantilla del cole que aún no están en
  // titulares ni en banquillo. Solo para "añadir suplente" — la jugador/a
  // tiene que estar realmente libre.
  const availableFromRoster = () => {
    const usedNames = new Set();
    [...starters, ...bench].forEach((p) => {
      if (p.name?.trim()) usedNames.add(p.name.trim().toLowerCase());
    });
    return SANTA_ANA_ROSTER.filter((p) => !usedNames.has(p.name.toLowerCase()));
  };

  // Para elegir una titular: excluye a las que ya ocupan OTROS slots de
  // titular (no se pueden duplicar en el campo) Y a la que está actualmente
  // en este slot (sería un no-op). Incluye a las del banquillo (para hacer
  // swap: ella sube, la actual baja) y a las sin asignar. Cada opción lleva
  // un marcador _source que el modal usa para mostrar de dónde viene.
  const availableForStarter = (currentIdx) => {
    const excluded = new Set();
    starters.forEach((p, i) => {
      if (p?.name?.trim()) excluded.add(p.name.trim().toLowerCase());
    });
    return SANTA_ANA_ROSTER
      .filter((p) => !excluded.has(p.name.toLowerCase()))
      .map((p) => {
        const inBench = bench.some(
          (b) => b?.name && b.name.toLowerCase() === p.name.toLowerCase()
        );
        return { ...p, _source: inBench ? 'bench' : 'free' };
      });
  };

  const loadRoster = () => {
    // Carga las 4 primeras como titulares y el resto como banquillo,
    // ordenadas por dorsal.
    const sorted = [...SANTA_ANA_ROSTER];
    const starters4 = sorted.slice(0, 4).map((p) => ({ ...p }));
    const benchRest = sorted.slice(4).map((p) => ({ ...p }));
    // Rellena hasta 4 si el roster tiene menos
    while (starters4.length < 4) starters4.push({ name: '', number: null });
    setStarters(starters4);
    setBench(benchRest);
  };

  const clearAll = () => {
    setStarters([
      { name: '', number: null }, { name: '', number: null },
      { name: '', number: null }, { name: '', number: null },
    ]);
    setBench([]);
  };

  const pickFromRoster = (pickedPlayer) => {
    if (!picker) return;
    // _source es un marcador del modal (bench/free) para mostrar el badge.
    // Lo quitamos antes de guardar para no contaminar los datos persistidos.
    const { _source, ...clean } = pickedPlayer;
    if (picker.scope === 'starter') {
      const ns = [...starters];
      // Si la jugador/a estaba en banquillo, sácala
      setBench(bench.filter(
        (b) => !(b.name === clean.name && b.number === clean.number)
      ));
      // Si ya había alguien en este puesto y tiene nombre, mándalo al banquillo
      const previous = ns[picker.idx];
      ns[picker.idx] = { ...clean };
      setStarters(ns);
      if (previous.name?.trim()) {
        setBench((prev) => [...prev, previous]);
      }
    } else if (picker.scope === 'bench') {
      // Añadir al banquillo (en la posición picker.idx si es válida)
      const nb = [...bench];
      if (picker.idx === 'new') {
        nb.push({ ...clean });
      } else {
        nb[picker.idx] = { ...clean };
      }
      setBench(nb);
    }
    setPicker(null);
  };

  // Tras crear el partido se abre un modal de compartir para que el padre
  // creador pueda enviarlo al grupo de WhatsApp inmediatamente. La navegación
  // al match ocurre al cerrar el modal (botón "Ir al partido").
  const [createdMatch, setCreatedMatch] = useState(null);

  const handleStart = async () => {
    setCreating(true); setError(null);
    try {
      const positions = starters.map((p, i) => ({
        name: (p.name || '').trim() || POSITION_SHORT[i],
        ...(p.number != null ? { number: p.number } : {}),
      }));
      const benchPlayers = bench
        .filter((p) => (p.name || '').trim())
        .map((p) => ({
          name: p.name.trim(),
          ...(p.number != null ? { number: p.number } : {}),
        }));
      const m = await createMatch({
        teamA: teamA.trim(),
        teamB: teamB.trim(),
        format,
        location: location.trim(),
        firstServe,
        positions,
        bench: benchPlayers,
      }, userId);
      trackVisited(m.id);
      setCreatedMatch(m);
      setCreating(false);
    } catch (e) {
      setError(e.message || 'Error al crear el partido');
      setCreating(false);
    }
  };

  return (
    <div className="px-5 pt-10 pb-6">
      <button onClick={() => navigate('')} className="flex items-center gap-1 text-brand-green font-medium mb-6">
        <ChevronLeft size={20} /> Inicio
      </button>
      <h1 className="text-2xl font-bold mb-6 text-slate-900">Nuevo partido</h1>

      <Field label="Equipo local" count={{ current: teamA.length, max: LIMITS.teamNameMax }}>
        <input value={teamA} onChange={(e) => setTeamA(e.target.value)} maxLength={LIMITS.teamNameMax} placeholder="Ej. Santa Ana y San Rafael" className="w-full p-3.5 bg-white border border-slate-200 rounded-xl outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/10 shadow-card transition" />
      </Field>
      <Field label="Equipo visitante" count={{ current: teamB.length, max: LIMITS.teamNameMax }}>
        <input value={teamB} onChange={(e) => setTeamB(e.target.value)} maxLength={LIMITS.teamNameMax} placeholder="Ej. CV Pozuelo" className="w-full p-3.5 bg-white border border-slate-200 rounded-xl outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/10 shadow-card transition" />
      </Field>
      <Field label="Lugar (opcional)">
        <input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={LIMITS.locationMax} placeholder="Pabellón..." className="w-full p-3.5 bg-white border border-slate-200 rounded-xl outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/10 shadow-card transition" />
      </Field>
      <Field label="Formato">
        <div className="grid grid-cols-2 gap-2">
          <SelectBtn active={format === 'bo3'} onClick={() => setFormat('bo3')}>Al mejor de 3</SelectBtn>
          <SelectBtn active={format === 'bo5'} onClick={() => setFormat('bo5')}>Al mejor de 5</SelectBtn>
        </div>
      </Field>
      <Field label="Saque inicial">
        <div className="grid grid-cols-2 gap-2">
          <SelectBtn active={firstServe === 'A'} onClick={() => setFirstServe('A')} variant="green">{teamA || 'Local'}</SelectBtn>
          <SelectBtn active={firstServe === 'B'} onClick={() => setFirstServe('B')} variant="green">{teamB || 'Visitante'}</SelectBtn>
        </div>
      </Field>

      <div className="mb-5 p-3 bg-brand-green-soft border border-brand-green/20 rounded-2xl flex items-center justify-between gap-2">
        <div className="text-sm">
          <div className="font-bold text-brand-green-dark">Plantilla del cole</div>
          <div className="text-xs text-slate-600">11 jugadores/as del Santa Ana y San Rafael</div>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button onClick={loadRoster} className="px-3 py-2 bg-brand-green text-white rounded-xl text-xs font-bold shadow-card">Cargar</button>
          {(starters.some((p) => p.name) || bench.length > 0) && (
            <button onClick={clearAll} className="px-3 py-2 bg-white border border-red-200 text-red-500 hover:bg-red-50 rounded-xl text-xs font-medium">Vaciar</button>
          )}
        </div>
      </div>

      <Field label="Titulares en campo">
        <div className="space-y-2">
          {starters.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="w-14 h-14 rounded-xl bg-brand-green-soft flex flex-col items-center justify-center font-bold text-brand-green flex-shrink-0 px-1 py-1.5">
                <div className="text-xs leading-none">{POSITION_SHORT[i]}</div>
                <div className="text-[11px] font-medium leading-tight mt-1 text-center w-full">{POSITION_LABELS[i]}</div>
              </div>
              {rosterLoaded ? (
                <button
                  onClick={() => setPicker({ scope: 'starter', idx: i })}
                  className="flex-1 p-3 bg-white border border-slate-200 rounded-xl text-left flex items-center justify-between shadow-card"
                >
                  <span className={p.name ? 'text-slate-900 font-medium truncate' : 'text-slate-400'}>
                    {p.name ? (
                      <>
                        {p.name}
                        {p.number != null && <span className="ml-2 text-brand-green font-mono text-sm">#{p.number}</span>}
                      </>
                    ) : (
                      `Elegir jugador/a ${POSITION_LABELS[i].toLowerCase()}`
                    )}
                  </span>
                  <ChevronLeft size={16} className="rotate-180 text-slate-400 flex-shrink-0 ml-2" />
                </button>
              ) : (
                <input
                  value={p.name}
                  onChange={(e) => {
                    const np = [...starters];
                    np[i] = { ...np[i], name: e.target.value };
                    setStarters(np);
                  }}
                  maxLength={LIMITS.playerNameMax}
                  placeholder={`Jugador/a ${POSITION_LABELS[i].toLowerCase()}`}
                  className="flex-1 p-3 bg-white border border-slate-200 rounded-xl outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/10 shadow-card transition"
                />
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500 mt-2">P1 saca primero. Editable después por cualquier padre/madre.</p>
      </Field>

      <Field label={`Suplentes${bench.length > 0 ? ` (${bench.length})` : ''}`}>
        <div className="space-y-2">
          {bench.map((p, i) => (
            // Grid con anchos fijos en las columnas exteriores para que el
            // badge S# y la X de quitar queden siempre alineados aunque
            // los nombres tengan longitudes muy distintas (Inés vs Guillermo).
            <div key={i} className="grid grid-cols-[56px_1fr_40px] gap-2 items-center">
              <div className="h-14 rounded-xl bg-slate-100 flex items-center justify-center text-slate-500 text-xs font-bold">S{i + 1}</div>
              {rosterLoaded ? (
                <button
                  onClick={() => setPicker({ scope: 'bench', idx: i })}
                  className="w-full p-3 bg-white border border-slate-200 rounded-xl text-left flex items-center justify-between shadow-card min-w-0"
                >
                  <span className={`min-w-0 truncate ${p.name ? 'text-slate-900 font-medium' : 'text-slate-400'}`}>
                    {p.name ? (
                      <>
                        {p.name}
                        {p.number != null && <span className="ml-2 text-brand-green font-mono text-sm">#{p.number}</span>}
                      </>
                    ) : 'Elegir suplente'}
                  </span>
                  <ChevronLeft size={16} className="rotate-180 text-slate-400 flex-shrink-0 ml-2" />
                </button>
              ) : (
                <input
                  value={p.name}
                  onChange={(e) => {
                    const nb = [...bench];
                    nb[i] = { ...nb[i], name: e.target.value };
                    setBench(nb);
                  }}
                  maxLength={LIMITS.playerNameMax}
                  placeholder="Nombre"
                  className="w-full p-3 bg-white border border-slate-200 rounded-xl outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/10 shadow-card transition min-w-0"
                />
              )}
              <button onClick={() => setBench(bench.filter((_, idx) => idx !== i))} className="h-10 rounded-xl bg-white border border-slate-200 text-slate-400 hover:text-red-500 transition flex items-center justify-center" aria-label="Quitar suplente">
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={() => rosterLoaded ? setPicker({ scope: 'bench', idx: 'new' }) : setBench([...bench, { name: '', number: null }])}
          className="w-full mt-2 p-3 bg-white border-2 border-dashed border-slate-300 rounded-xl text-sm text-slate-600 font-medium flex items-center justify-center gap-1.5 hover:border-brand-green hover:text-brand-green transition"
        >
          <Plus size={16} /> Añadir suplente{rosterLoaded ? ' del cole' : ''}
        </button>
        <p className="text-xs text-slate-500 mt-2">Opcional. Durante el partido podrás añadir más y hacer sustituciones.</p>
      </Field>

      {error && <p className="text-sm text-red-500 mb-3">{error}</p>}

      <button disabled={!canStart} onClick={handleStart} className="w-full p-4 bg-gradient-to-r from-brand-green to-brand-green-dark text-white disabled:from-slate-300 disabled:to-slate-300 disabled:text-slate-500 rounded-2xl font-semibold flex items-center justify-center gap-2 transition mt-4 shadow-card-md">
        <Play size={20} /> {creating ? 'Creando…' : 'Empezar partido'}
      </button>
      <p className="text-xs text-slate-500 text-center mt-3">Recibirás un enlace para compartir con el grupo de padres y madres.</p>

      {picker && (
        <RosterPickerModal
          title={picker.scope === 'starter'
            ? `Elegir ${POSITION_LABELS[picker.idx].toLowerCase()} (${POSITION_SHORT[picker.idx]})`
            : 'Añadir suplente'}
          options={picker.scope === 'starter'
            ? availableForStarter(picker.idx)
            : availableFromRoster()}
          onPick={pickFromRoster}
          onClose={() => setPicker(null)}
        />
      )}

      {createdMatch && (
        <ShareAfterCreateModal
          match={createdMatch}
          onContinue={() => {
            // replace: true para que el botón atrás del móvil desde el
            // marcador vaya a Inicio en vez de volver al formulario.
            navigate(`#/match/${createdMatch.id}`, { replace: true });
            setCreatedMatch(null);
          }}
        />
      )}
    </div>
  );
}

// Modal que aparece automáticamente tras crear un partido nuevo, antes de
// navegar a la pantalla del match. Permite al padre/madre creador compartir
// el enlace al grupo de WhatsApp en el momento de crear el partido (que es
// cuando suele querer hacerlo). Botones para WhatsApp, copiar al portapapeles,
// share nativo del sistema, y "Ir al partido" para continuar.
function ShareAfterCreateModal({ match, onContinue }) {
  const [copied, setCopied] = useState(false);

  const url = `${window.location.origin}/#/match/${match.id}`;
  const message = `🏐 Sigue el partido EN VIVO\n${match.teamA} vs ${match.teamB}${match.location ? `\n📍 ${match.location}` : ''}\n\n${url}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {}
      document.body.removeChild(ta);
    }
  };

  const shareNative = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `${match.teamA} vs ${match.teamB}`,
          text: message,
          url,
        });
      } catch (e) {
        if (e.name !== 'AbortError') console.warn(e);
      }
    } else {
      // Fallback: si no hay share nativo, copia el enlace
      copyLink();
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in">
      <div className="bg-white rounded-t-3xl sm:rounded-3xl p-5 w-full max-w-md shadow-card-lg animate-in-pop max-h-[90vh] overflow-y-auto">
        {/* Cabecera con check verde */}
        <div className="flex flex-col items-center text-center mb-4">
          <div className="w-14 h-14 rounded-full bg-brand-green-soft flex items-center justify-center mb-2">
            <CheckCircle2 size={32} className="text-brand-green" />
          </div>
          <h3 className="text-xl font-bold text-slate-900">¡Partido creado!</h3>
          <p className="text-[14px] text-slate-500 mt-1 px-2">
            Compártelo con el grupo de padres y madres para que puedan seguirlo en vivo.
          </p>
        </div>

        {/* Detalles del partido */}
        <div className="mb-4 p-3 bg-brand-green-soft border border-brand-green/20 rounded-2xl">
          <div className="font-semibold text-slate-900 text-center text-[15px]">
            {match.teamA} <span className="text-slate-400">vs</span> {match.teamB}
          </div>
          {match.location && (
            <div className="text-xs text-slate-500 text-center mt-1">📍 {match.location}</div>
          )}
        </div>

        {/* URL para copiar */}
        <div className="mb-4 p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 break-all font-mono">
          {url}
        </div>

        {/* Botones de compartir: Compartir (share nativo del SO, incluye
            WhatsApp / Messages / AirDrop / Telegram / etc.) y Copiar
            enlace. El share nativo hace fallback a copiar si el navegador
            no lo soporta. */}
        <div className="grid grid-cols-2 gap-2 mb-2">
          <button
            onClick={shareNative}
            className="p-3 bg-brand-green hover:bg-brand-green-dark text-white rounded-xl font-semibold flex items-center justify-center gap-2 transition shadow-card"
          >
            <Share2 size={18} /> Compartir
          </button>
          <button
            onClick={copyLink}
            className="p-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-semibold flex items-center justify-center gap-2 transition"
          >
            {copied
              ? (<><Check size={18} className="text-emerald-500" /> Copiado</>)
              : (<><Copy size={18} /> Copiar</>)
            }
          </button>
        </div>

        <p className="text-[12px] text-slate-400 text-center mb-3 mt-1">
          Cualquier padre/madre con el enlace podrá ver y editar el partido.
        </p>

        {/* Continuar al match */}
        <button
          onClick={onContinue}
          className="w-full p-3.5 bg-gradient-to-br from-brand-green to-brand-green-dark text-white rounded-2xl font-bold text-base flex items-center justify-center gap-2 shadow-card transition active:scale-[0.98]"
        >
          Ir al partido <Play size={18} />
        </button>
      </div>
    </div>
  );
}

// Modal genérico que muestra la plantilla del cole para elegir una jugador/a.
// Cada opción puede llevar un campo _source: 'bench' (está actualmente en
// banquillo → al elegirla se hace swap con la titular saliente) o 'free'
// (sin asignar → entra directamente como titular). Se muestra un badge
// visual para que el usuario lo entienda.
function RosterPickerModal({ title, options, onPick, onClose }) {
  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white rounded-t-3xl sm:rounded-3xl p-5 w-full max-w-md shadow-card-lg animate-in max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-slate-900">{title}</h3>
          <button onClick={onClose} className="text-slate-400 p-1"><X size={20} /></button>
        </div>
        {options.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-8">No quedan jugadores/as disponibles en la plantilla del cole.</p>
        ) : (
          <div className="space-y-2">
            {options.map((p) => (
              <button
                key={`${p.name}-${p.number}`}
                onClick={() => onPick(p)}
                className="w-full p-3.5 bg-white border border-slate-200 rounded-xl text-left font-medium hover:border-brand-green hover:bg-brand-green-soft/40 transition flex items-center justify-between gap-2"
              >
                <span className="flex items-center gap-3 min-w-0">
                  <span className="w-9 h-9 bg-brand-green-soft text-brand-green-dark rounded-lg flex items-center justify-center font-mono font-bold text-sm flex-shrink-0">{p.number}</span>
                  <span className="text-slate-900 truncate">{p.name}</span>
                </span>
                <span className="flex items-center gap-2 flex-shrink-0">
                  {p._source === 'bench' && (
                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                      Banquillo
                    </span>
                  )}
                  <ChevronLeft size={16} className="rotate-180 text-slate-400" />
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children, hint, count }) {
  // `hint` muestra un texto auxiliar bajo el input (gris).
  // `count` es un objeto {current, max} para mostrar contador X/N. Se
  // pone en amarillo cuando current >= 80% del max para avisar al
  // usuario que se esta acercando al limite, y en rojo cuando llega al
  // tope (current === max).
  let counterClass = 'text-slate-400';
  if (count) {
    const ratio = count.current / count.max;
    if (count.current === count.max) counterClass = 'text-red-500 font-semibold';
    else if (ratio >= 0.8) counterClass = 'text-amber-600 font-medium';
  }
  return (
    <div className="mb-5">
      <div className="flex items-baseline justify-between mb-2">
        <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wide">{label}</label>
        {count && (
          <span className={`text-xs tabular-nums ${counterClass}`}>
            {count.current}/{count.max}
          </span>
        )}
      </div>
      {children}
      {hint && <div className="text-xs text-slate-500 mt-1.5">{hint}</div>}
    </div>
  );
}
function SelectBtn({ active, onClick, children, variant = 'green' }) {
  const activeClass = variant === 'blue'
    ? 'bg-brand-green text-white shadow-card'
    : 'bg-brand-green text-white shadow-card';
  return <button onClick={onClick} className={`p-3 rounded-xl font-semibold transition ${active ? activeClass : 'bg-white border border-slate-200 text-slate-700'}`}>{children}</button>;
}

// ============ MATCH ============
function MatchView({ matchId }) {
  const [match, setMatch] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState('score');
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState(null);
  const [editingLineup, setEditingLineup] = useState(false);
  const [quickSubIdx, setQuickSubIdx] = useState(null); // null | 0..3 — posición sobre la que se quiere sustituir directamente
  const [rotationFlash, setRotationFlash] = useState(false);
  const [winnerCelebration, setWinnerCelebration] = useState(null); // {team: 'A'|'B'} cuando hay que mostrar el modal celebratorio
  const [confirmReopen, setConfirmReopen] = useState(false);
  const inflight = useRef(false);
  const prevPositionsRef = useRef(null);
  const prevWinnerRef = useRef(); // sentinel: undefined = aún sin inicializar
  const prevSetsCountRef = useRef(null); // último (setsA, setsB) observado para detectar empate decisivo
  const initializedRef = useRef(false);

  useEffect(() => { trackVisited(matchId); }, [matchId]);

  // Forzar el scroll al top al abrir el partido o cambiar de tab. Usamos
  // useLayoutEffect (no useEffect) para ejecutarse SÍNCRONAMENTE tras las
  // mutaciones del DOM y ANTES del paint del navegador — es la diferencia
  // crucial: con useEffect, el browser puede pintar el frame con el scroll
  // a media altura antes de que el scrollTo entre en juego.
  // Triple defensa adicional: scrollTo síncrono + doble RAF + setTimeout.
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
    const scrollTop = () => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };
    scrollTop();
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => {
        scrollTop();
        requestAnimationFrame(scrollTop);
      });
    }
    const t = setTimeout(scrollTop, 50);
    const t2 = setTimeout(scrollTop, 200);
    return () => { clearTimeout(t); clearTimeout(t2); };
  }, [matchId, loading, tab]);

  // Auto-cierre por inactividad: si el partido lleva mas de STALE_MATCH_MINUTES
  // minutos sin ningun update en BD (nadie ha sumado/restado/sustituido,
  // etc.), lo finalizamos automaticamente. Se chequea al cargar el match
  // y luego cada 60s mientras esta abierto.
  //
  // Nota sobre dependencia: el effect se reinicia cuando cambia
  // match.updatedAt, lo cual sucede con cada interaccion. Eso es deseable:
  // cualquier accion del usuario "resetea" el contador implicitamente
  // porque cambia updatedAt -> nuevo cutoff -> 30 min frescos.
  useEffect(() => {
    if (!match || match.finished) return;
    const check = () => {
      const cutoff = Date.now() - STALE_MATCH_MINUTES * 60 * 1000;
      if (match.updatedAt < cutoff) {
        finishMatch(matchId)
          .then((closed) => {
            setMatch(closed);
            setToast({
              key: Date.now(),
              kind: 'info',
              message: `Cerrado automáticamente tras ${STALE_MATCH_MINUTES} min sin actividad`,
              highlight: 'Auto-cierre',
            });
          })
          .catch((e) => console.error('No se pudo auto-cerrar partido', e));
      }
    };
    check(); // chequeo inmediato al cargar / cuando cambia el match
    const interval = setInterval(check, 60 * 1000);
    return () => clearInterval(interval);
  }, [match?.updatedAt, match?.finished, matchId]);

  // Detectar cuando se proclama un ganador (winner pasa de null a 'A'/'B')
  // para abrir un modal de celebración grande con confetti y trofeo. El
  // partido NO se cierra; sigue jugando hasta completar el formato (set 3
  // en BO3, set 5 en BO5). El cierre es automático tras el último set.
  useEffect(() => {
    if (!match) return;
    const curr = match.winner || null;
    if (prevWinnerRef.current === undefined) {
      prevWinnerRef.current = curr;
      return;
    }
    const prev = prevWinnerRef.current;
    if (prev === null && curr) {
      setWinnerCelebration({ team: curr });
    }
    prevWinnerRef.current = curr;
  }, [match?.winner]);

  // Detectar cuando se cierra un set y resulta en EMPATE DECISIVO (1-1 en
  // BO3, 2-2 en BO5). En esos casos el siguiente set decide el partido y
  // queremos avisar al/la padre/madre con un toast informativo. Se muestra
  // una sola vez por evento usando prevSetsCountRef para evitar repetir
  // el aviso al cambiar de tab o tras reabrir el match.
  useEffect(() => {
    if (!match || match.finished || match.winner) return;
    const closedSets = uniqueSetsByNumber(match.sets);
    const setsA = closedSets.filter((s) => s.a > s.b).length;
    const setsB = closedSets.filter((s) => s.b > s.a).length;
    const key = `${setsA}-${setsB}`;
    if (prevSetsCountRef.current === null) {
      prevSetsCountRef.current = key;
      return;
    }
    if (prevSetsCountRef.current !== key) {
      const isDecisiveDraw =
        (match.format === 'bo3' && setsA === 1 && setsB === 1) ||
        (match.format === 'bo5' && setsA === 2 && setsB === 2);
      if (isDecisiveDraw) {
        setToast({
          key: Date.now(),
          kind: 'info',
          message: 'El próximo set decide el partido 🏐',
          highlight: 'Set decisivo',
        });
      }
      prevSetsCountRef.current = key;
    }
  }, [match?.sets, match?.winner, match?.finished, match?.format]);

  // Detectar cambios en posiciones (rotación o edición de plantilla)
  useEffect(() => {
    if (!match?.positions) return;
    const currStr = JSON.stringify(match.positions);
    const prevStr = prevPositionsRef.current;
    if (initializedRef.current && prevStr && prevStr !== currStr && !match.finished) {
      const prev = JSON.parse(prevStr);
      const isRot = isCyclicRotation(prev, match.positions);
      if (isRot) {
        setRotationFlash(true);
        setTimeout(() => setRotationFlash(false), 1500);
        // Tras una rotación, el/la jugador/a en P1 pasa a sacar. Lo
        // mostramos como `highlight` (segunda línea destacada y centrada)
        // para que se lea de un vistazo aunque el padre/madre esté lejos
        // del móvil.
        const newServer = match.positions[0];
        const serverName = newServer?.name;
        const serverNumber = newServer?.number;
        const highlight = serverName
          ? `Saca ${serverName}${serverNumber != null ? ` #${serverNumber}` : ''}`
          : null;
        setToast({
          message: '↻ Rotación aplicada',
          highlight,
          kind: 'info',
          key: Date.now(),
        });
      } else {
        setToast({ message: '✏️ Plantilla actualizada', kind: 'info', key: Date.now() });
      }
    }
    prevPositionsRef.current = currStr;
    initializedRef.current = true;
  }, [match?.positions, match?.finished]);

  useEffect(() => {
    let unsub = null; let cancelled = false;
    (async () => {
      try {
        const m = await getMatch(matchId);
        if (cancelled) return;
        if (!m) { setNotFound(true); setLoading(false); return; }
        setMatch(m); setLoading(false);
        unsub = subscribeToMatch(matchId, (updated) => setMatch(updated));
      } catch (e) {
        console.error(e); setNotFound(true); setLoading(false);
      }
    })();
    return () => { cancelled = true; if (unsub) unsub(); };
  }, [matchId]);

  const showToast = useCallback((message, kind = 'info') => {
    setToast({ message, kind, key: Date.now() });
  }, []);

  const haptic = () => { try { navigator.vibrate?.(10); } catch {} };

  const handleAddPoint = async (team) => {
    if (!match || match.finished || inflight.current) return;
    haptic();
    inflight.current = true; setSyncing(true);
    try {
      const res = await apiAddPoint(matchId, team);
      if (res.deduped) {
        showToast(`Punto ya sumado hace ${res.secondsAgo ?? 0}s por otro padre/madre`, 'warn');
      } else {
        setMatch(res.match);
        if (res.match.finished) showToast('¡Partido finalizado y guardado!', 'success');
      }
    } catch (e) { console.error(e); showToast(e.message || 'Error al sumar punto', 'error'); }
    finally { inflight.current = false; setSyncing(false); }
  };

  const handleSubtract = async (team) => {
    if (!match || match.finished) return;
    haptic(); setSyncing(true);
    try {
      const res = await apiSubtractPoint(matchId, team);
      // Defensa: solo actualizamos el match si el RPC devolvió algo
      // utilizable. Si el formato fuera inesperado (RPC antiguo sin
      // migración o respuesta corrupta), evitamos pisar el state con
      // null/undefined y romper la pantalla.
      if (res && res.match) {
        setMatch(res.match);
      }
      if (res?.deduped) {
        showToast(`Resta ya aplicada hace ${res.secondsAgo ?? 0}s por otro padre/madre`, 'warn');
      }
    } catch (e) {
      console.error(e);
      showToast('No se pudo restar', 'error');
    } finally { setSyncing(false); }
  };

  const handleReopen = async () => {
    if (!match || !match.finished) return;
    setConfirmReopen(false);
    setSyncing(true);
    try {
      const m = await reopenMatch(matchId);
      setMatch(m);
      showToast('Partido reabierto', 'success');
    } catch (e) {
      console.error(e);
      showToast('No se pudo reabrir', 'error');
    } finally { setSyncing(false); }
  };

  const handleUndo = async () => {
    if (!match || !match.lastPointBy) return;
    haptic(); setSyncing(true);
    try { setMatch(await apiUndoPoint(matchId)); }
    catch (e) { showToast('No se pudo deshacer', 'error'); }
    finally { setSyncing(false); }
  };

  const handleRotate = async () => {
    if (!match) return;
    haptic(); setSyncing(true);
    try { setMatch(await rotatePositions(matchId, match.positions)); }
    catch (e) { showToast('No se pudo rotar', 'error'); }
    finally { setSyncing(false); }
  };

  const handleEnd = async () => {
    if (!match) return;
    setSyncing(true);
    try {
      setMatch(await finishMatch(matchId));
      showToast('Partido guardado en "Mis partidos"', 'success');
    } catch (e) { showToast('Error al finalizar', 'error'); }
    finally { setSyncing(false); }
  };

  const handleSaveRoster = async (newPositions, newBench, opts = {}) => {
    setSyncing(true);
    try {
      setMatch(await updateRoster(matchId, newPositions, newBench));
      if (!opts.keepOpen) setEditingLineup(false);
      if (opts.keepOpen) showToast('Sustitución aplicada ✓', 'success');
      // El toast de cambio general lo dispara el useEffect que detecta cambio de positions
    } catch (e) { showToast('No se pudo guardar', 'error'); }
    finally { setSyncing(false); }
  };

  if (loading) return <FullScreen>Cargando partido…</FullScreen>;
  if (notFound) return (
    <div className="px-5 pt-12">
      <FullScreenError title="Partido no encontrado" detail="El enlace puede no existir o haberse borrado." />
      <div className="text-center mt-4"><button onClick={() => navigate('')} className="text-brand-green font-semibold">← Volver al inicio</button></div>
    </div>
  );

  const sets = uniqueSetsByNumber(match.sets);
  const setsA = sets.filter((s) => s.a > s.b).length;
  const setsB = sets.filter((s) => s.b > s.a).length;
  const [colorA, colorB] = teamColorPair(match.teamA, match.teamB);

  return (
    <div>
      {toast && <Toast key={toast.key} message={toast.message} highlight={toast.highlight} kind={toast.kind} onClose={() => setToast(null)} />}
      {/* Header sticky */}
      <div className="px-5 pt-10 pb-3 sticky top-0 bg-slate-50/95 backdrop-blur-md z-10 border-b border-slate-200">
        <div className="flex items-center justify-between mb-3">
          <button onClick={() => navigate('')} className="text-brand-green flex items-center gap-1 font-medium text-sm">
            <ChevronLeft size={18} /> Inicio
          </button>
          <div className="flex items-center gap-2">
            <span className="text-[16px] text-slate-500 uppercase tracking-wider font-bold">
              Set {match.currentSet.number} · {match.format === 'bo5' ? 'BO5' : 'BO3'}
            </span>
            {syncing && <Wifi size={12} className="text-brand-green pulse-live" />}
            {!match.finished && (
              <span className="flex items-center gap-1 text-[15px] text-red-500 font-bold">
                <span className="w-1.5 h-1.5 bg-red-500 rounded-full pulse-live" /> LIVE
              </span>
            )}
          </div>
          {!match.finished ? <button onClick={handleUndo} className="text-red-500 text-sm font-medium">Deshacer</button> : <div className="w-12" />}
        </div>

        <div className="flex items-stretch gap-2">
          <TeamHeader name={match.teamA} sets={setsA} serving={match.server === 'A' && !match.finished} color={colorA} maxNameLength={Math.max(match.teamA.length, match.teamB.length)} />
          <div className="flex items-center text-slate-300 text-base font-bold">VS</div>
          <TeamHeader name={match.teamB} sets={setsB} serving={match.server === 'B' && !match.finished} color={colorB} maxNameLength={Math.max(match.teamA.length, match.teamB.length)} />
        </div>

        {/* Banner: equipo ha ganado el partido pero seguimos jugando hasta
            completar el formato (3 sets en BO3, 5 sets en BO5). El cierre
            es automático al terminar el último set. */}
        {match.winner && !match.finished && (
          <div className="mt-3 px-3 py-2 bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-300 rounded-xl flex items-center gap-2 text-amber-900">
            <Trophy size={18} className="text-amber-600 flex-shrink-0" />
            <div className="text-[13px] leading-tight">
              <span className="font-bold">{match.winner === 'A' ? match.teamA : match.teamB}</span> gana el partido.
              <span className="text-amber-700"> Seguid jugando hasta el {match.format === 'bo5' ? 'set 5' : 'set 3'} — el partido se cierra solo al terminarlo.</span>
            </div>
          </div>
        )}

        <MatchTimes match={match} />
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 bg-white">
        <TabBtn active={tab === 'score'} onClick={() => setTab('score')}><Trophy size={16} /> Marcador</TabBtn>
        <TabBtn active={tab === 'rotation'} onClick={() => setTab('rotation')}><Users size={16} /> Rotación</TabBtn>
      </div>

      {tab === 'score' && <ScoreTab match={match} onPoint={handleAddPoint} onSubtract={handleSubtract} onReopen={() => setConfirmReopen(true)} onEnd={handleEnd} />}
      {tab === 'rotation' && <RotationTab match={match} flash={rotationFlash} onRotate={handleRotate} onEditLineup={() => setEditingLineup(true)} onCellClick={(idx) => setQuickSubIdx(idx)} />}

      {/* Botones de acción del partido. En partidos en curso ambos botones
          comparten una fila (grid 2 columnas) para ahorrar espacio vertical.
          Si el partido ya ha terminado, solo aparece Compartir (ancho
          completo). */}
      <div className="px-5 mt-2">
        {match.finished ? (
          <ShareButton match={match} />
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <ShareButton match={match} />
            <button onClick={handleEnd} className="w-full p-4 bg-white border border-red-200 text-red-500 hover:bg-red-50 rounded-2xl font-semibold text-sm shadow-card transition flex items-center justify-center">
              Finalizar partido
            </button>
          </div>
        )}
      </div>

      {editingLineup && (
        <RosterModal
          positions={match.positions}
          bench={match.bench || []}
          onSave={handleSaveRoster}
          onClose={() => setEditingLineup(false)}
        />
      )}

      {quickSubIdx !== null && (
        <QuickSubModal
          positionIdx={quickSubIdx}
          positions={match.positions}
          bench={match.bench || []}
          onClose={() => setQuickSubIdx(null)}
          onSubstitute={async (incoming) => {
            // Ejecuta la sustitución y persiste a BD. Cierra el modal al
            // terminar. Mismo principio que el RosterModal en v1.5.0.
            const newPositions = match.positions.map((p, i) =>
              i === quickSubIdx ? { ...incoming } : { ...(p || {}) }
            );
            const newBench = (match.bench || []).filter(
              (b) => !(b.name === incoming.name && b.number === incoming.number)
            );
            const outgoing = match.positions[quickSubIdx];
            if (outgoing?.name?.trim()) newBench.push({ ...outgoing });
            const persistedPositions = newPositions.map((p, i) => ({
              ...(p || {}),
              name: ((p && p.name) || '').trim() || POSITION_SHORT[i],
            }));
            const persistedBench = newBench
              .map((p) => ({ ...p, name: (p.name || '').trim() }))
              .filter((p) => p.name);
            setQuickSubIdx(null);
            await handleSaveRoster(persistedPositions, persistedBench, { keepOpen: true });
          }}
          onOpenFullPanel={() => {
            setQuickSubIdx(null);
            setEditingLineup(true);
          }}
        />
      )}

      {confirmReopen && (
        <ConfirmModal
          title="¿Reabrir el partido?"
          message="Volverá a estar en juego con el marcador tal y como quedó. Si el partido ya tenía un ganador, podrás corregir los puntos con el botón 'Restar punto'."
          confirmText="Sí, reabrir"
          variant="primary"
          onConfirm={handleReopen}
          onClose={() => setConfirmReopen(false)}
        />
      )}

      {winnerCelebration && (
        <WinnerCelebrationModal
          teamName={winnerCelebration.team === 'A' ? match.teamA : match.teamB}
          isLocal={winnerCelebration.team === 'A'}
          playedSets={setsA + setsB}
          maxSets={match.format === 'bo5' ? 5 : 3}
          onClose={() => setWinnerCelebration(null)}
        />
      )}
    </div>
  );
}

function TeamHeader({ name, sets, serving, color, maxNameLength }) {
  const t = colorTokens(color);
  // El numero grande de sets y la etiqueta "SETS" van en la MISMA linea
  // (flex con baseline). Tamano del nombre adaptativo segun la longitud
  // del nombre mas largo de los dos equipos:
  //   <=14 chars  →  18px (text-lg)
  //   <=22 chars  →  16px (text-base)
  //   >22 chars   →  14px (text-sm)
  //
  // OVERFLOW: dos defensas combinadas para nombres patologicos.
  //   1) overflow-wrap: anywhere en el div del nombre — permite que el
  //      texto rompa en cualquier punto cuando no hay espacios. Esto es
  //      clave para nombres largos sin espacios (ej. "Kdkdkkdkdkdkd"),
  //      donde break-words/overflow-wrap:break-word NO rompe y deja el
  //      texto desbordando fuera de la card.
  //   2) overflow-hidden en el contenedor de la card — defensa de
  //      ultimo recurso para que si algo se sale, no se vea fuera del
  //      cuadro.
  //
  // ALINEACION ENTRE CARDS: justify-between (no justify-center). El
  // nombre va en un wrapper flex-1 con items-center, asi se centra
  // verticalmente DENTRO del espacio sobrante. El bloque del numero+SETS
  // va en una posicion FIJA al fondo de la card. Como items-stretch del
  // contenedor padre iguala el alto de ambas cards, los numeros quedan
  // siempre a la misma altura.
  //
  // SAQUE: el 🏐 va como BADGE ABSOLUTO en la esquina superior izquierda.
  // No participa en el flow del texto.
  const len = maxNameLength ?? name.length;
  const nameSize = len > 22 ? 'text-sm'
                 : len > 14 ? 'text-base'
                 : 'text-lg';
  return (
    <div className={`relative flex-1 p-3 ${t.bgSoft} rounded-2xl min-w-0 overflow-hidden flex flex-col items-center text-center justify-between gap-2`}>
      {serving && (
        <span
          className="absolute top-1.5 left-1.5 text-sm leading-none select-none z-10"
          aria-label="Saca este equipo"
          role="img"
        >
          🏐
        </span>
      )}
      <div className="flex-1 flex items-center justify-center w-full min-w-0">
        <div
          className={`font-semibold text-slate-900 leading-tight ${nameSize} w-full`}
          style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
        >
          {name}
        </div>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-3xl font-bold tabular-nums leading-none ${t.text}`}>{sets}</span>
        <span className="text-[13px] text-slate-500 uppercase tracking-wide font-semibold leading-none">sets</span>
      </div>
    </div>
  );
}

function MatchTimes({ match }) {
  const now = useNow(!match.finished);
  const end = match.endedAt || now;
  const dur = formatDuration(end - match.startedAt);
  return (
    <div className="text-[15px] text-slate-500 mt-2.5 flex items-center gap-1.5 justify-center font-medium">
      <Clock size={11} />
      <span>Inicio <span className="text-slate-700 font-semibold tabular-nums">{formatHHMM(match.startedAt)}</span></span>
      {match.endedAt && (
        <>
          <span className="text-slate-300">→</span>
          <span>Fin <span className="text-slate-700 font-semibold tabular-nums">{formatHHMM(match.endedAt)}</span></span>
        </>
      )}
      <span className="text-slate-300">·</span>
      <span className="text-slate-700 font-semibold tabular-nums">{dur}</span>
    </div>
  );
}

function TabBtn({ active, onClick, children }) {
  return <button onClick={onClick} className={`flex-1 py-3.5 flex items-center justify-center gap-2 text-sm font-semibold transition ${active ? 'text-brand-green border-b-2 border-brand-green' : 'text-slate-400'}`}>{children}</button>;
}

function ScoreTab({ match, onPoint, onSubtract, onReopen, onEnd }) {
  const [colorA, colorB] = teamColorPair(match.teamA, match.teamB);
  return (
    <div className="px-5 py-6 bg-slate-50">
      {match.finished ? (
        <FinishedSummary match={match} onReopen={onReopen} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <ScoreButton name={match.teamA} score={match.currentSet.a} onAdd={() => onPoint('A')} onSubtract={() => onSubtract('A')} color={colorA} maxNameLength={Math.max(match.teamA.length, match.teamB.length)} />
            <ScoreButton name={match.teamB} score={match.currentSet.b} onAdd={() => onPoint('B')} onSubtract={() => onSubtract('B')} color={colorB} maxNameLength={Math.max(match.teamA.length, match.teamB.length)} />
          </div>
          <p className="text-[16px] text-slate-500 text-center mb-4 px-4 leading-relaxed">
            Si varios padres/madres pulsan el mismo punto en menos de 10s, solo cuenta una vez.
          </p>
        </>
      )}

      {/* ShareButton + Finalizar se han movido a MatchView para que aparezcan
          también en la tab Rotación. ShareButton va arriba (intercambiado con
          Finalizar que va abajo). */}

      {uniqueSetsByNumber(match.sets).length > 0 && !match.finished && (
        <div className="mt-8">
          <h3 className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-3">Sets jugados</h3>
          <div className="space-y-2">
            {uniqueSetsByNumber(match.sets).map((s) => <SetRow key={s.number} set={s} teamA={match.teamA} teamB={match.teamB} colorA={colorA} colorB={colorB} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function SetRow({ set: s, teamA, teamB, colorA, colorB }) {
  // Si no nos pasan colores, los calculamos para mantener compatibilidad
  // con las llamadas que aún no pasen el par.
  const [resolvedA, resolvedB] = colorA && colorB
    ? [colorA, colorB]
    : teamColorPair(teamA, teamB);
  const aWon = s.a > s.b;
  const ta = colorTokens(resolvedA);
  const tb = colorTokens(resolvedB);
  return (
    <div className="flex items-center justify-between p-3.5 bg-white rounded-xl border border-slate-200 shadow-card">
      <span className="text-slate-400 text-xs uppercase tracking-wide font-bold">Set {s.number}</span>
      <div className="flex items-center gap-4 font-mono font-bold text-lg">
        <span className={aWon ? ta.text : 'text-slate-400'}>{s.a}</span>
        <span className="text-slate-300">·</span>
        <span className={!aWon ? tb.text : 'text-slate-400'}>{s.b}</span>
      </div>
    </div>
  );
}

function FinishedSummary({ match, onReopen }) {
  const sets = uniqueSetsByNumber(match.sets);
  const setsA = sets.filter((s) => s.a > s.b).length;
  const setsB = sets.filter((s) => s.b > s.a).length;
  // Si el partido tiene `winner` registrado en BD (alcanzó sets_needed
  // antes de finalizar), lo usamos. Si no — caso típico: el usuario pulsó
  // "Finalizar partido" manualmente sin completar la regla de sets — lo
  // derivamos del marcador. Si está empatado, no hay ganador y mostramos
  // un resumen neutro sin trofeo.
  let derivedWinner = match.winner;
  if (!derivedWinner) {
    if (setsA > setsB) derivedWinner = 'A';
    else if (setsB > setsA) derivedWinner = 'B';
    else derivedWinner = null; // empate sin desempate
  }
  const isDraw = derivedWinner === null;
  const winnerName = derivedWinner === 'A' ? match.teamA : derivedWinner === 'B' ? match.teamB : null;
  // Color del ganador según el esquema (Santa Ana = verde, rival = azul).
  const [colorA, colorB] = teamColorPair(match.teamA, match.teamB);
  const winnerColor = derivedWinner === 'A' ? colorA : derivedWinner === 'B' ? colorB : 'green';
  const wt = colorTokens(winnerColor);
  const duration = match.endedAt ? formatDuration(match.endedAt - match.startedAt) : null;
  return (
    <div className={`px-5 py-8 ${wt.gradientSoft}`}>
      <div className="text-center py-4">
        {isDraw ? (
          <>
            <div className="text-5xl mb-3" aria-hidden="true">🤝</div>
            <div className="text-xs uppercase tracking-wider text-slate-500 font-bold mb-1">Partido finalizado</div>
            <h2 className="text-2xl font-bold mb-2 text-slate-700">Sin ganador</h2>
          </>
        ) : (
          <>
            <Trophy size={48} className={`mx-auto mb-3 ${wt.text}`} />
            <div className="text-xs uppercase tracking-wider text-slate-500 font-bold mb-1">Ganador</div>
            <h2 className={`text-2xl font-bold mb-2 ${wt.text}`}>{winnerName}</h2>
          </>
        )}
        <div className="text-3xl font-bold text-slate-900 tabular-nums">{setsA}–{setsB}</div>
        <div className="text-xs text-slate-500 mt-3 flex items-center justify-center gap-2 flex-wrap">
          <span>{new Date(match.startedAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
          {duration && <span>· {duration}</span>}
          {match.location && <span>· {match.location}</span>}
        </div>
        <div className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 border border-emerald-200 rounded-full text-emerald-700 text-xs font-medium">
          <CheckCircle2 size={14} /> Guardado en Mis partidos
        </div>
      </div>

      <div className="mt-6">
        <h3 className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-3 text-center">Sets</h3>
        <div className="space-y-2">
          {sets.map((s) => <SetRow key={s.number} set={s} teamA={match.teamA} teamB={match.teamB} colorA={colorA} colorB={colorB} />)}
        </div>
      </div>

      {onReopen && (
        <button
          onClick={onReopen}
          className="w-full mt-6 p-3 bg-white border border-red-200 text-red-500 hover:bg-red-50 rounded-xl text-sm font-medium shadow-card flex items-center justify-center gap-2 transition"
        >
          <RotateCw size={15} /> Reabrir partido
        </button>
      )}
    </div>
  );
}

function ScoreButton({ name, score, onAdd, onSubtract, color, maxNameLength }) {
  const t = colorTokens(color);
  // Tamaño calculado sobre el nombre más largo de los dos equipos para
  // mantener simetría. Si no se pasa, cae al propio (compat).
  //   <=12 chars  →  16px (text-base)
  //   <=18 chars  →  14px (text-sm)
  //   >18 chars   →  13px
  const len = maxNameLength ?? name.length;
  const nameSize = len > 18 ? 'text-[13px]'
                 : len > 12 ? 'text-sm'
                 : 'text-base';
  return (
    <div className="rounded-2xl overflow-hidden shadow-card-md flex flex-col">
      <button
        onClick={onAdd}
        className={`aspect-[3/4] bg-gradient-to-br from-white to-slate-50 border border-slate-200 border-b-0 p-3 flex flex-col justify-between ${t.activeFrom} ${t.activeTo} active:text-white transition`}
      >
        <div
          className={`text-slate-500 uppercase tracking-wider font-bold leading-tight line-clamp-2 text-center ${nameSize} w-full`}
          style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
        >{name}</div>
        <ScoreNumber score={score} accent={t.text} />
        <div className={`flex items-center justify-center gap-1 ${t.text} font-bold`}>
          <Plus size={18} /> <span className="text-sm">PUNTO</span>
        </div>
      </button>
      <button
        onClick={onSubtract}
        disabled={score === 0}
        className="w-full py-2.5 bg-red-50 text-red-500 hover:bg-red-100 disabled:opacity-30 disabled:text-slate-400 disabled:bg-slate-100 text-xs font-medium flex items-center justify-center gap-1 border border-t-0 border-red-200 rounded-b-2xl transition"
      >
        <Minus size={13} /> Restar punto
      </button>
    </div>
  );
}

// Cuando el score es de un solo dígito (0-9) lo mostramos a tamaño completo.
// Con dos dígitos (10-99) reducimos el tamaño para que quepa horizontal sin
// romper la tarjeta. Para 3 dígitos (caso teórico improbable) lo bajamos más.
// Antes apilábamos los dígitos verticalmente con leading muy comprimido y
// quedaba feo y poco legible. Esta versión simplemente se adapta en ancho.
function ScoreNumber({ score, accent }) {
  const len = String(score).length;
  const sizeClass = len === 1 ? 'text-7xl' : len === 2 ? 'text-6xl' : 'text-5xl';
  return (
    <div className={`${sizeClass} font-bold text-center my-2 font-mono tabular-nums leading-none ${accent}`}>
      {score}
    </div>
  );
}

function RotationTab({ match, flash, onRotate, onEditLineup, onCellClick }) {
  const pos = match.positions || [];
  const isServingA = match.server === 'A' && !match.finished;
  const streak = isServingA ? (match.serveStreak || 0) : 0;
  // El campo siempre representa al equipo local (A). Su color sigue al
  // del cole si A es Santa Ana, o al azul si A es el rival.
  const [colorA] = teamColorPair(match.teamA, match.teamB);
  const ta = colorTokens(colorA);
  // Layout en rombo 3x3:
  //   .  P3 .
  //   P2 .  P4
  //   .  P1 .
  // P1 (índice 0) = saque, P2 (1) = izquierda, P3 (2) = centro, P4 (3) = derecha
  return (
    <div className="px-5 py-6 bg-slate-50">
      <div className="text-[16px] uppercase tracking-widest text-slate-400 mb-2 text-center font-bold">Red ▲</div>
      <div className={`bg-gradient-to-b ${colorA === 'blue' ? 'from-brand-blue-soft' : 'from-brand-green-soft'} to-white ${ta.border} border rounded-3xl p-5 mb-6 shadow-card ${flash ? 'animate-rotation-flash' : ''}`}>
        <div className="grid grid-cols-3 gap-2">
          {/* Fila 1: solo P3 centro */}
          <div />
          <CourtCell player={pos[2]} index={2} color={colorA} onClick={onCellClick ? () => onCellClick(2) : undefined} />
          <div />
          {/* Fila 2: P2 izquierda, vacío, P4 derecha */}
          <CourtCell player={pos[1]} index={1} color={colorA} onClick={onCellClick ? () => onCellClick(1) : undefined} />
          <div className="flex items-center justify-center text-[15px] text-slate-400 font-medium">CAMPO</div>
          <CourtCell player={pos[3]} index={3} color={colorA} onClick={onCellClick ? () => onCellClick(3) : undefined} />
          {/* Fila 3: solo P1 saque */}
          <div />
          <CourtCell player={pos[0]} index={0} color={colorA} isServer={isServingA} onClick={onCellClick ? () => onCellClick(0) : undefined} />
          <div />
        </div>
        {isServingA && streak > 0 && (
          <div className={`mt-3 text-center text-[13px] font-semibold ${ta.textDark}`}>
            Saques seguidos: {streak} / 3
            {streak >= 3 && <span className="ml-1 text-red-500">· al próximo punto rota</span>}
          </div>
        )}
        <div className="mt-2 text-center text-[12px] text-slate-500">
          Toca a un/a jugador/a para sustituirlo/a
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <button onClick={onRotate} className="p-4 bg-white border border-red-200 rounded-2xl font-semibold flex items-center justify-center gap-2 shadow-card text-red-500 hover:bg-red-50 active:bg-red-100 transition">
          <RotateCw size={18} className="text-red-500" /> Rotar
        </button>
        <button onClick={onEditLineup} className={`p-4 bg-white border border-slate-200 rounded-2xl font-semibold flex items-center justify-center gap-2 shadow-card text-slate-700 active:bg-slate-100 transition`}>
          <Users size={18} className={ta.textDark} /> Plantilla
        </button>
      </div>
      <p className="text-xs text-slate-500 text-center px-4 leading-relaxed">
        Rotación automática: al ganar el saque (side-out) y al 4º punto consecutivo sacando. Cualquier padre/madre puede rotar manualmente, sustituir o añadir suplentes.
      </p>
    </div>
  );
}

function CourtCell({ player, index, isServer = false, onClick, color = 'green' }) {
  const label = POSITION_LABELS[index];
  const clickable = typeof onClick === 'function';
  const t = colorTokens(color);
  const baseClass = `aspect-square rounded-2xl flex flex-col items-center justify-center px-1.5 py-2 shadow-card transition ${isServer ? `${t.gradient} text-white` : 'bg-white border border-slate-200'} ${clickable ? 'cursor-pointer active:scale-95 active:shadow-card-md' : ''}`;
  const inner = (
    <>
      <div className={`text-[15px] font-mono font-bold leading-none ${isServer ? 'text-white/85' : t.text}`}>
        {POSITION_SHORT[index]}{isServer && ' 🏐'}
      </div>
      {/* Nombre: wrap natural, break-words por si algún nombre carece de espacios.
          Sin truncate (antes cortaba con "..." hasta nombres cortos como "Lucia"
          porque la celda es aspect-square pequeña). */}
      <div className={`text-[15px] font-bold text-center leading-[1.1] mt-1 w-full break-words hyphens-auto ${isServer ? 'text-white' : 'text-slate-900'}`}>
        {player?.name || '—'}
      </div>
      {player?.number != null && (
        <div className={`font-mono text-[13px] leading-none mt-1 ${isServer ? 'text-white/80' : t.text}`}>
          #{player.number}
        </div>
      )}
      <div className={`text-[13px] font-medium leading-none mt-1 ${isServer ? 'text-white/80' : `${t.text} opacity-70`}`}>
        {label}
      </div>
    </>
  );
  if (clickable) {
    return (
      <button type="button" onClick={onClick} aria-label={`Sustituir ${player?.name || POSITION_SHORT[index]}`} className={baseClass}>
        {inner}
      </button>
    );
  }
  return <div className={baseClass}>{inner}</div>;
}

// ============ MODAL CONFIRMACIÓN genérico ============
function ConfirmModal({ title, message, confirmText, cancelText = 'Cancelar', variant = 'primary', onConfirm, onClose }) {
  const confirmClass = variant === 'danger'
    ? 'bg-red-500 hover:bg-red-600'
    : 'bg-gradient-to-r from-brand-green to-brand-green-dark';
  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-3xl p-5 w-full max-w-md shadow-card-lg animate-in" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold mb-2 text-slate-900">{title}</h3>
        <p className="text-sm text-slate-600 mb-5 leading-relaxed">{message}</p>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={onClose} className="p-3 bg-slate-100 text-slate-700 rounded-xl font-medium">
            {cancelText}
          </button>
          <button onClick={onConfirm} className={`p-3 text-white rounded-xl font-semibold shadow-card ${confirmClass}`}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============ WINNER CELEBRATION MODAL ============
// Modal grande de celebración que aparece la primera vez que un equipo
// alcanza los sets necesarios. Confetti CSS puro (sin librerías) cayendo
// sobre un card con trofeo animado y el nombre del equipo ganador.
function WinnerCelebrationModal({ teamName, isLocal, playedSets, maxSets, onClose }) {
  // Diferenciamos dos situaciones:
  //
  // A) El partido se gana ANTICIPADAMENTE (ej. 2-0 en BO3, 3-0 o 3-1 en
  //    BO5): aun quedan sets por jugar que NO afectan al resultado.
  //    Mensaje informativo: "los siguientes son amistosos".
  //
  // B) El partido se gana en el ULTIMO SET posible (ej. 2-1 en BO3, 3-2
  //    en BO5): no quedan mas sets. Mensaje: "el partido ha terminado".
  //
  // El criterio es comparar sets jugados con el maximo del formato.
  const hasMoreSets = playedSets < maxSets;

  // Generamos 60 piezas de confetti con propiedades aleatorias estables
  // por instancia del componente (useMemo).
  const confettiPieces = React.useMemo(() => {
    const colors = ['#007E59', '#006048', '#4EB05D', '#FBBF24', '#F59E0B', '#EF4444', '#8B5CF6', '#3B82F6', '#EC4899'];
    return Array.from({ length: 60 }).map((_, i) => ({
      id: i,
      left: Math.random() * 100,           // % horizontal
      delay: Math.random() * 0.8,          // s
      duration: 2.5 + Math.random() * 2.5, // s (2.5 - 5s)
      color: colors[i % colors.length],
      size: 6 + Math.random() * 8,         // px
      rotate: Math.random() * 360,         // deg inicial
      drift: -50 + Math.random() * 100,    // deriva horizontal
      shape: Math.random() > 0.5 ? 'square' : 'circle',
    }));
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-hidden bg-slate-900/60 backdrop-blur-sm animate-in"
      onClick={onClose}
    >
      {/* Confetti */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {confettiPieces.map((p) => (
          <span
            key={p.id}
            className="absolute top-0 block"
            style={{
              left: `${p.left}%`,
              width: `${p.size}px`,
              height: `${p.size}px`,
              backgroundColor: p.color,
              borderRadius: p.shape === 'circle' ? '50%' : '2px',
              animation: `confetti-fall ${p.duration}s ${p.delay}s cubic-bezier(.2,.6,.4,1) infinite`,
              '--drift': `${p.drift}px`,
              '--rot-start': `${p.rotate}deg`,
            }}
          />
        ))}
      </div>

      {/* Card central */}
      <div
        className="relative bg-white rounded-3xl shadow-card-lg p-7 w-full max-w-sm text-center animate-in-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Trofeo grande con bounce */}
        <div className="text-7xl mb-2 animate-trophy-bounce select-none" aria-hidden="true">
          🏆
        </div>

        <div className="text-xs uppercase tracking-widest font-bold text-amber-600 mb-1">
          ¡Ganador del partido!
        </div>
        <div className="text-2xl font-bold text-slate-900 mb-1 leading-tight break-words">
          {teamName}
        </div>
        <div className="text-base text-slate-600 mb-1">
          {isLocal ? 'gana el partido 🎉' : 'gana el partido'}
        </div>

        <div className="mt-5 p-3 bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-2xl text-[13px] text-amber-900 leading-snug">
          {hasMoreSets ? (
            <>
              <strong>El partido ya está decidido.</strong>{' '}
              Si jugáis el resto de sets, no afectan al resultado final.
            </>
          ) : (
            <>
              <strong>El partido ha terminado.</strong>{' '}
              Se han jugado todos los sets.
            </>
          )}
        </div>

        <button
          onClick={onClose}
          className="mt-5 w-full p-3.5 bg-gradient-to-br from-brand-green to-brand-green-dark text-white rounded-2xl font-bold text-base shadow-card active:scale-[0.98] transition"
        >
          {hasMoreSets ? '¡Continuar! 🏐' : '¡Ver resumen!'}
        </button>
      </div>
    </div>
  );
}

// ============ QUICK SUB MODAL ============
// Modal compacto que se abre al tocar una jugador/a en el campo (RotationTab).
// Muestra "Sale: [Nombre]" y la lista de suplentes del banquillo. Al pulsar
// uno, se sustituye al instante. Tiene también un botón para abrir el modal
// Plantilla completa si el padre necesita renombrar, añadir suplentes, etc.
function QuickSubModal({ positionIdx, positions, bench, onSubstitute, onClose, onOpenFullPanel }) {
  const outgoing = positions?.[positionIdx];
  const benchAvailable = (bench || []).filter((p) => p?.name?.trim());
  const label = POSITION_LABELS[positionIdx];
  const shortLabel = POSITION_SHORT[positionIdx];
  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-t-3xl sm:rounded-3xl p-5 w-full max-w-md shadow-card-lg animate-in max-h-[88vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-bold flex items-center gap-2 text-slate-900">
            <RotateCw size={20} className="text-brand-green" /> Sustituir
          </h3>
          <button onClick={onClose} className="text-slate-400 p-1" aria-label="Cerrar"><X size={20} /></button>
        </div>

        <div className="mb-4 p-3 bg-brand-green-soft border border-brand-green/20 rounded-2xl">
          <div className="text-[11px] uppercase tracking-wider text-brand-green-dark/70 font-bold mb-1">Sale</div>
          <div className="flex items-center justify-between">
            <span className="font-bold text-slate-900 text-base">{outgoing?.name || '—'}</span>
            {outgoing?.number != null && (
              <span className="font-mono text-brand-green-dark text-sm">#{outgoing.number}</span>
            )}
          </div>
          <div className="text-xs text-slate-500 mt-1">{label} ({shortLabel})</div>
        </div>

        <div className="text-[11px] uppercase tracking-wider text-slate-500 font-bold mb-2">Entra desde el banquillo</div>

        {benchAvailable.length === 0 ? (
          <div className="text-center py-6 text-sm text-slate-500">
            No hay suplentes en el banquillo.
            <div className="mt-3">
              <button onClick={onOpenFullPanel} className="px-4 py-2 bg-brand-green text-white rounded-xl text-sm font-semibold">
                Abrir Plantilla para añadir
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2 mb-4">
            {benchAvailable.map((p, i) => (
              <button
                key={`${p.name}-${p.number ?? i}`}
                onClick={() => onSubstitute(p)}
                className="w-full p-3.5 bg-white border border-slate-200 rounded-xl text-left font-medium hover:border-brand-green hover:bg-brand-green-soft/40 transition flex items-center justify-between active:scale-[0.99]"
              >
                <span className="truncate">{p.name}</span>
                {p.number != null && <span className="font-mono text-brand-green text-sm flex-shrink-0 ml-2">#{p.number}</span>}
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 mt-2">
          <button onClick={onClose} className="p-3 bg-slate-100 text-slate-700 rounded-xl font-medium">
            Cancelar
          </button>
          <button onClick={onOpenFullPanel} className="p-3 bg-white border border-brand-green/30 text-brand-green-dark rounded-xl font-medium flex items-center justify-center gap-2">
            <Users size={16} /> Plantilla
          </button>
        </div>
      </div>
    </div>
  );
}

// ============ MODAL PLANTILLA con sustituciones ============
// Si las jugadores/as vienen con dorsales (plantilla del cole cargada), activa
// los selectores tipo dropdown. Si no, fallback a inputs editables.
function RosterModal({ positions, bench, onSave, onClose }) {
  const [court, setCourt] = useState(() => positions.map((p) => ({ ...(p || {}) })));
  const [benchList, setBench] = useState(() => (bench || []).map((p) => ({ ...(p || {}) })));
  const [swapping, setSwapping] = useState(null);
  const [renamingIdx, setRenamingIdx] = useState(null);
  const [picker, setPicker] = useState(null);
  // La plantilla del cole está SIEMPRE activa: los slots son selectores que
  // abren el RosterPickerModal con la lista de jugadores/as del Santa Ana.
  const rosterLoaded = true;

  // Jugadores/as del cole no usadas ni en campo ni en banquillo.
  // Solo para "añadir suplente" — la jugador/a debe estar libre.
  const availableFromRoster = () => {
    const usedNames = new Set();
    [...court, ...benchList].forEach((p) => {
      if (p?.name?.trim()) usedNames.add(p.name.trim().toLowerCase());
    });
    return SANTA_ANA_ROSTER.filter((p) => !usedNames.has(p.name.toLowerCase()));
  };

  // Para elegir titular: incluye también a las del banquillo (swap directo).
  // Excluye a TODAS las que están en titulares (incluida la del slot actual,
  // para evitar duplicarla en el banquillo si se re-elige).
  const availableForStarter = (currentIdx) => {
    const excluded = new Set();
    court.forEach((p) => {
      if (p?.name?.trim()) excluded.add(p.name.trim().toLowerCase());
    });
    return SANTA_ANA_ROSTER
      .filter((p) => !excluded.has(p.name.toLowerCase()))
      .map((p) => {
        const inBench = benchList.some(
          (b) => b?.name && b.name.toLowerCase() === p.name.toLowerCase()
        );
        return { ...p, _source: inBench ? 'bench' : 'free' };
      });
  };

  const handleSubstitute = (incomingIdx) => {
    if (swapping === null) return;
    const outgoing = { ...court[swapping] };
    const incoming = { ...benchList[incomingIdx] };
    const newCourt = [...court];
    newCourt[swapping] = incoming;
    const newBench = benchList.filter((_, i) => i !== incomingIdx);
    if (outgoing.name?.trim()) newBench.push(outgoing);
    setCourt(newCourt);
    setBench(newBench);
    setSwapping(null);
    // Persistir INMEDIATAMENTE a la BD para que la sustitución se vea en la
    // vista Rotación sin necesidad de pulsar "Guardar". Antes esta acción
    // solo cambiaba el estado local del modal y, si el usuario cerraba sin
    // guardar, la sustitución no se aplicaba en la cancha. Ahora cada Sub
    // se aplica a la BD al instante (idempotente y barato).
    const persistedPositions = newCourt.map((p, i) => ({
      ...(p || {}),
      name: ((p && p.name) || '').trim() || POSITION_SHORT[i],
    }));
    const persistedBench = newBench
      .map((p) => ({ ...p, name: (p.name || '').trim() }))
      .filter((p) => p.name);
    onSave(persistedPositions, persistedBench, { keepOpen: true });
  };

  const handlePick = (pickedPlayer) => {
    if (!picker) return;
    // _source es marcador del modal, no se persiste.
    const { _source, ...clean } = pickedPlayer;
    let nc = court;
    let nb = benchList;
    if (picker.scope === 'starter') {
      const previous = { ...court[picker.idx] };
      nc = [...court];
      nc[picker.idx] = { ...clean };
      nb = benchList.filter(
        (b) => !(b.name === clean.name && b.number === clean.number)
      );
      if (previous.name?.trim()) nb = [...nb, previous];
      setCourt(nc);
      setBench(nb);
    } else if (picker.scope === 'bench') {
      nb = [...benchList, { ...clean }];
      setBench(nb);
    }
    setPicker(null);
    // Persistir cambio inmediato a BD (mismo motivo que en handleSubstitute)
    const persistedPositions = nc.map((p, i) => ({
      ...(p || {}),
      name: ((p && p.name) || '').trim() || POSITION_SHORT[i],
    }));
    const persistedBench = nb
      .map((p) => ({ ...p, name: (p.name || '').trim() }))
      .filter((p) => p.name);
    onSave(persistedPositions, persistedBench, { keepOpen: true });
  };

  const addBenchPlayer = () => setBench([...benchList, { name: '', number: null }]);
  const updateBenchName = (i, name) => {
    const nb = [...benchList];
    nb[i] = { ...nb[i], name };
    setBench(nb);
  };
  const removeBench = (i) => setBench(benchList.filter((_, idx) => idx !== i));

  const updateCourtName = (i, name) => {
    const nc = [...court];
    nc[i] = { ...nc[i], name };
    setCourt(nc);
  };

  const save = () => {
    // Conservamos TODAS las propiedades (name, number, ...) y solo
    // garantizamos que name nunca esté vacío para los titulares.
    const newPositions = court.map((p, i) => {
      const trimmedName = (p.name || '').trim();
      return {
        ...p,
        name: trimmedName || POSITION_SHORT[i],
      };
    });
    const newBench = benchList
      .map((p) => ({ ...p, name: (p.name || '').trim() }))
      .filter((p) => p.name);
    onSave(newPositions, newBench);
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-t-3xl sm:rounded-3xl p-5 w-full max-w-md shadow-card-lg animate-in max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-bold flex items-center gap-2 text-slate-900">
            <Users size={20} className="text-brand-green" /> Plantilla
          </h3>
          <button onClick={onClose} className="text-slate-400 p-1" aria-label="Cerrar"><X size={20} /></button>
        </div>

        {swapping !== null ? (
          // Selector de quién entra desde el banquillo
          <>
            <p className="text-sm text-slate-700 mb-1">Sale: <span className="font-semibold">{court[swapping]?.name || '—'}</span>{court[swapping]?.number != null && <span className="text-brand-green ml-1 font-mono">#{court[swapping].number}</span>}</p>
            <p className="text-xs text-slate-500 mb-4">¿Quién entra por {POSITION_LABELS[swapping]} ({POSITION_SHORT[swapping]})?</p>
            <div className="space-y-2 mb-3">
              {benchList.length === 0 && (
                <p className="text-sm text-slate-400 italic text-center py-6">No hay suplentes disponibles. Añade alguna en el banquillo.</p>
              )}
              {benchList.map((p, i) => (
                <button key={i} disabled={!p.name?.trim()} onClick={() => handleSubstitute(i)} className="w-full p-3.5 bg-white border border-slate-200 rounded-xl text-left font-medium hover:border-brand-green hover:bg-brand-green-soft/40 disabled:opacity-40 transition flex items-center justify-between">
                  <span className="truncate flex items-center gap-2">
                    {p.number != null && <span className="font-mono text-xs text-brand-green-dark bg-brand-green-soft px-2 py-0.5 rounded">#{p.number}</span>}
                    {p.name?.trim() || '(sin nombre)'}
                  </span>
                  <ChevronLeft size={16} className="rotate-180 text-slate-400" />
                </button>
              ))}
            </div>
            <button onClick={() => setSwapping(null)} className="w-full p-3 bg-slate-100 text-slate-700 rounded-xl font-medium">Cancelar</button>
          </>
        ) : (
          // Vista normal: campo + banquillo
          <>
            <h4 className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-2">En campo (4)</h4>
            <div className="space-y-2 mb-5">
              {court.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="w-14 h-14 rounded-xl bg-brand-green-soft flex flex-col items-center justify-center font-bold text-brand-green flex-shrink-0 px-1 py-1.5">
                    <div className="text-xs leading-none">{POSITION_SHORT[i]}</div>
                    <div className="text-[11px] font-medium leading-tight mt-1 text-center w-full">{POSITION_LABELS[i]}</div>
                  </div>
                  {renamingIdx === i ? (
                    <input
                      autoFocus
                      value={p.name || ''}
                      onChange={(e) => updateCourtName(i, e.target.value)}
                      onBlur={() => setRenamingIdx(null)}
                      onKeyDown={(e) => e.key === 'Enter' && setRenamingIdx(null)}
                      maxLength={LIMITS.playerNameMax}
                      className="flex-1 p-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-brand-green"
                    />
                  ) : rosterLoaded ? (
                    <button
                      onClick={() => setPicker({ scope: 'starter', idx: i })}
                      className="flex-1 p-3 bg-slate-50 border border-slate-200 rounded-xl text-left font-medium truncate flex items-center justify-between"
                    >
                      <span className={p.name ? 'text-slate-900' : 'text-slate-400 italic'}>
                        {p.name ? (
                          <>
                            {p.name}
                            {p.number != null && <span className="ml-2 font-mono text-sm text-brand-green-dark">#{p.number}</span>}
                          </>
                        ) : 'Sin asignar'}
                      </span>
                      <ChevronLeft size={14} className="rotate-180 text-slate-400 flex-shrink-0" />
                    </button>
                  ) : (
                    <button onClick={() => setRenamingIdx(i)} className="flex-1 p-3 bg-slate-50 border border-slate-200 rounded-xl text-left font-medium truncate">
                      {p.name || <span className="text-slate-400 italic">Sin nombre</span>}
                    </button>
                  )}
                  <button onClick={() => setSwapping(i)} className="px-3 h-12 rounded-xl bg-brand-green-soft text-brand-green-dark font-semibold text-sm flex items-center gap-1 flex-shrink-0">
                    <RotateCw size={14} /> Sub
                  </button>
                </div>
              ))}
            </div>

            <h4 className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-2">Banquillo ({benchList.length})</h4>
            <div className="space-y-2 mb-2">
              {benchList.map((p, i) => (
                <div key={i} className="grid grid-cols-[56px_1fr_40px] gap-2 items-center">
                  <div className="h-14 rounded-xl bg-slate-100 flex flex-col items-center justify-center text-slate-500">
                    <div className="text-xs font-bold leading-none">S{i + 1}</div>
                    {p.number != null && <div className="text-[10px] font-mono text-brand-green-dark mt-0.5">#{p.number}</div>}
                  </div>
                  <input
                    value={p.name || ''}
                    onChange={(e) => updateBenchName(i, e.target.value)}
                    maxLength={LIMITS.playerNameMax}
                    placeholder="Nombre"
                    className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-brand-green min-w-0"
                  />
                  <button onClick={() => removeBench(i)} className="h-10 rounded-xl bg-white border border-slate-200 text-slate-400 hover:text-red-500 transition flex items-center justify-center" aria-label="Quitar">
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
            <div className="grid gap-2 mb-5">
              {rosterLoaded ? (
                <button onClick={() => setPicker({ scope: 'bench', idx: 'new' })} className="w-full p-3 bg-brand-green-soft border-2 border-dashed border-brand-green/30 rounded-xl text-sm text-brand-green-dark font-medium flex items-center justify-center gap-1.5 hover:border-brand-green hover:bg-brand-green-soft/70 transition">
                  <Plus size={16} /> Añadir suplente del cole
                </button>
              ) : (
                <button onClick={addBenchPlayer} className="w-full p-3 bg-white border-2 border-dashed border-slate-300 rounded-xl text-sm text-slate-600 font-medium flex items-center justify-center gap-1.5 hover:border-brand-green hover:text-brand-green transition">
                  <Plus size={16} /> Añadir suplente
                </button>
              )}
            </div>

            <button onClick={save} className="w-full p-4 bg-gradient-to-r from-brand-green to-brand-green-dark text-white rounded-2xl font-semibold flex items-center justify-center gap-2 shadow-card-md">
              <Check size={18} /> Guardar
            </button>
          </>
        )}

        {picker && (
          <RosterPickerModal
            title={picker.scope === 'starter'
              ? `Cambiar ${POSITION_LABELS[picker.idx].toLowerCase()} (${POSITION_SHORT[picker.idx]})`
              : 'Añadir suplente del cole'}
            options={picker.scope === 'starter'
              ? availableForStarter(picker.idx)
              : availableFromRoster()}
            onPick={handlePick}
            onClose={() => setPicker(null)}
          />
        )}
      </div>
    </div>
  );
}


// ============ HISTORY ============
function HistoryView({ userId }) {
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    listMatchesByIds(getVisitedIds()).then((m) => { setMatches(m); setLoading(false); });
  }, []);

  const handleDelete = async () => {
    if (!confirmDelete) return;
    const match = confirmDelete.match;
    const isOwner = match.createdBy === userId;
    setConfirmDelete(null);
    try {
      if (isOwner) {
        await deleteMatch(match.id);
      }
      forgetVisited(match.id);
      setMatches((prev) => prev.filter((m) => m.id !== match.id));
      setToast({ message: isOwner ? 'Partido eliminado' : 'Partido quitado de tu lista', kind: 'success', key: Date.now() });
    } catch (e) {
      console.error(e);
      setToast({ message: 'No se pudo eliminar', kind: 'error', key: Date.now() });
    }
  };

  const inProgress = matches.filter((m) => !m.finished);
  const finished = matches.filter((m) => m.finished);
  return (
    <div className="px-5 pt-10 pb-6">
      <button onClick={() => navigate('')} className="flex items-center gap-1 text-brand-green font-medium mb-6">
        <ChevronLeft size={20} /> Inicio
      </button>
      <h1 className="text-2xl font-bold mb-2 text-slate-900">Mis partidos</h1>
      <p className="text-sm text-slate-500 mb-6">Todos tus partidos guardados, consultables cuando quieras.</p>

      {loading ? (
        <p className="text-slate-400 text-center py-12">Cargando…</p>
      ) : matches.length === 0 ? (
        <div className="text-center py-12 px-6">
          <Trophy size={40} className="mx-auto text-slate-300 mb-3" />
          <p className="text-slate-500 font-medium mb-1">Aún no hay partidos</p>
          <p className="text-xs text-slate-400">Crea uno desde el inicio o abre un enlace del grupo.</p>
        </div>
      ) : (
        <>
          {inProgress.length > 0 && (
            <div className="mb-6">
              <h2 className="text-xs uppercase tracking-wider text-red-500 font-bold mb-3 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-red-500 rounded-full pulse-live" /> En vivo
              </h2>
              {inProgress.map((m) => (
                <MatchCard
                  key={m.id} match={m} userId={userId}
                  onClick={() => navigate(`#/match/${m.id}`)}
                  onDelete={(match) => setConfirmDelete({ match })}
                />
              ))}
            </div>
          )}
          {finished.length > 0 && (
            <div>
              <h2 className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-3">Finalizados</h2>
              {finished.map((m) => (
                <MatchCard
                  key={m.id} match={m} userId={userId}
                  onClick={() => navigate(`#/match/${m.id}`)}
                  onDelete={(match) => setConfirmDelete({ match })}
                />
              ))}
            </div>
          )}
        </>
      )}
      <VersionFooter />

      {toast && <Toast key={toast.key} message={toast.message} highlight={toast.highlight} kind={toast.kind} onClose={() => setToast(null)} />}

      {confirmDelete && (
        <ConfirmModal
          title="¿Eliminar este partido?"
          message={
            confirmDelete.match.createdBy === userId
              ? 'Tú creaste este partido. Se borrará del servidor y desaparecerá también para el resto de padres/madres que tengan el enlace. No se puede deshacer.'
              : 'Lo quitará solo de tu lista. El partido seguirá existiendo para los/las demás y para quien lo creó.'
          }
          confirmText="Sí, eliminar"
          variant="danger"
          onConfirm={handleDelete}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
