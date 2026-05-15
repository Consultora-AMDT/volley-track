import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Trophy, Users, RotateCw, Plus, ChevronLeft, Home, History, Play,
  Wifi, WifiOff, AlertTriangle, Edit3, Check, X, CheckCircle2, Clock,
} from 'lucide-react';
import {
  isConfigured, ensureAuth, onAuthChange,
  createMatch, getMatch, listMatchesByIds,
  addPoint as apiAddPoint, undoPoint as apiUndoPoint,
  rotatePositions, updateLineup, updateRoster, finishMatch,
  subscribeToMatch,
} from './api.js';
import { trackVisited, getVisitedIds } from './storage.js';
import { LIMITS } from './config.js';
import { FeedbackButton } from './FeedbackButton.jsx';
import { ShareButton } from './ShareButton.jsx';

// Etiquetas de las 4 posiciones (P1=índice 0, P2=índice 1, etc.)
const POSITION_LABELS = ['Saque', 'Izquierda', 'Centro', 'Derecha'];
const POSITION_SHORT = ['P1', 'P2', 'P3', 'P4'];

// ============ ROUTER (hash) ============
function parseHash() {
  const h = window.location.hash || '';
  const m = h.match(/^#\/match\/([0-9a-f-]{36})$/i);
  if (m) return { view: 'match', id: m[1] };
  if (h === '#/setup') return { view: 'setup' };
  if (h === '#/history') return { view: 'history' };
  return { view: 'home' };
}
const navigate = (h) => { window.location.hash = h; };

// ============ HELPERS TIEMPO ============
const formatHHMM = (ts) => new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}

function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

// Detecta rotación cíclica horaria con 4 jugadoras:
//   prev = [P1, P2, P3, P4]  ->  curr = [P4, P1, P2, P3]
function isCyclicRotation(prev, curr) {
  if (!prev || !curr || prev.length !== 4 || curr.length !== 4) return false;
  return curr[0].name === prev[3].name
      && curr[1].name === prev[0].name
      && curr[2].name === prev[1].name
      && curr[3].name === prev[2].name;
}

// ============ APP ============
export default function App() {
  const [route, setRoute] = useState(parseHash());
  const [userId, setUserId] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [online, setOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
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
        {route.view === 'history' && <HistoryView />}
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
function Toast({ message, kind = 'info', onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 3000); return () => clearTimeout(t); }, [onClose]);
  const styles = kind === 'warn' ? 'bg-amber-50 border-amber-200 text-amber-900'
               : kind === 'error' ? 'bg-red-50 border-red-200 text-red-900'
               : kind === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
               : 'bg-white border-slate-200 text-slate-900';
  const Icon = kind === 'success' ? CheckCircle2 : AlertTriangle;
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

  useEffect(() => {
    listMatchesByIds(getVisitedIds()).then((m) => { setMatches(m); setLoading(false); });
  }, [userId]);

  const inProgress = matches.find((m) => !m.finished);
  const finished = matches.filter((m) => m.finished);

  return (
    <div className="px-5 pt-10 pb-6">
      {/* Header con logo */}
      <div className="flex items-center justify-between mb-2">
        <img src="/school-logo.png" alt="Santa Ana y San Rafael" className="h-12 w-auto" />
        <span className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">VolleyTrack</span>
      </div>

      <h1 className="text-3xl font-bold mt-6 mb-1 text-slate-900">Hola 👋</h1>
      <p className="text-slate-500 mb-8">Sigue los partidos de voleibol del cole en directo.</p>

      {inProgress && (
        <button
          onClick={() => navigate(`#/match/${inProgress.id}`)}
          className="w-full mb-3 p-4 bg-gradient-to-r from-brand-green to-brand-blue text-white rounded-2xl font-semibold flex items-center justify-between shadow-card-md transition"
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

      <button
        onClick={() => navigate('#/history')}
        className="w-full p-5 bg-white rounded-2xl font-semibold flex items-center justify-between transition border border-slate-200 shadow-card hover:shadow-card-md"
      >
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-brand-blue-soft flex items-center justify-center">
            <History size={22} className="text-brand-blue" />
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

      <div className="mt-6 p-4 bg-brand-blue-soft/60 rounded-2xl border border-brand-blue/10">
        <p className="text-xs text-slate-700 leading-relaxed">
          <strong className="text-brand-blue-dark">¿Te han pasado un enlace?</strong> Ábrelo desde WhatsApp. El partido aparecerá aquí y podrás sumar puntos junto al resto del grupo.
        </p>
      </div>

      {!loading && finished.length > 0 && (
        <div className="mt-8">
          <h2 className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-3">Recientes</h2>
          {finished.slice(0, 3).map((m) => <MatchCard key={m.id} match={m} onClick={() => navigate(`#/match/${m.id}`)} />)}
        </div>
      )}

      <FeedbackButton />
    </div>
  );
}

function MatchCard({ match, onClick }) {
  const setsA = match.sets.filter((s) => s.a > s.b).length;
  const setsB = match.sets.filter((s) => s.b > s.a).length;
  const wonA = match.winner === 'A';
  const wonB = match.winner === 'B';
  return (
    <button onClick={onClick} className="w-full text-left p-4 bg-white rounded-2xl mb-2 border border-slate-200 shadow-card hover:shadow-card-md transition">
      <div className="flex items-center justify-between mb-1.5">
        <span className={`font-semibold truncate ${wonA ? 'text-brand-green' : 'text-slate-900'}`}>{match.teamA}</span>
        <span className={`font-bold text-xl tabular-nums ${wonA ? 'text-brand-green' : 'text-slate-400'}`}>{setsA}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className={`truncate ${wonB ? 'text-brand-blue font-semibold' : 'text-slate-700'}`}>{match.teamB}</span>
        <span className={`font-bold text-xl tabular-nums ${wonB ? 'text-brand-blue' : 'text-slate-400'}`}>{setsB}</span>
      </div>
      <div className="text-xs text-slate-500 mt-2 flex items-center gap-2 font-normal">
        {new Date(match.startedAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}
        {!match.finished && (
          <span className="text-red-500 font-semibold flex items-center gap-1">
            <span className="w-1.5 h-1.5 bg-red-500 rounded-full pulse-live" /> EN VIVO
          </span>
        )}
        {match.location && <span className="text-slate-400">· {match.location}</span>}
      </div>
    </button>
  );
}

// ============ SETUP ============
function SetupView({ userId }) {
  const [teamA, setTeamA] = useState('');
  const [teamB, setTeamB] = useState('');
  const [format, setFormat] = useState('bo3'); // BO3 por defecto (infantil)
  const [location, setLocation] = useState('');
  const [firstServe, setFirstServe] = useState('A');
  // 4 titulares + suplentes (lista variable)
  const [starters, setStarters] = useState(['', '', '', '']);
  const [bench, setBench] = useState([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  const canStart = teamA.trim() && teamB.trim() && !creating;

  const handleStart = async () => {
    setCreating(true); setError(null);
    try {
      const positions = starters.map((name, i) => ({
        name: name.trim() || POSITION_SHORT[i],
      }));
      const benchPlayers = bench
        .map((n) => n.trim())
        .filter(Boolean)
        .map((name) => ({ name }));
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
      navigate(`#/match/${m.id}`);
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

      <Field label="Equipo local">
        <input value={teamA} onChange={(e) => setTeamA(e.target.value)} maxLength={LIMITS.teamNameMax} placeholder="Ej. Santa Ana" className="w-full p-3.5 bg-white border border-slate-200 rounded-xl outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/10 shadow-card transition" />
      </Field>
      <Field label="Equipo visitante">
        <input value={teamB} onChange={(e) => setTeamB(e.target.value)} maxLength={LIMITS.teamNameMax} placeholder="Ej. CV Pozuelo" className="w-full p-3.5 bg-white border border-slate-200 rounded-xl outline-none focus:border-brand-blue focus:ring-2 focus:ring-brand-blue/10 shadow-card transition" />
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
          <SelectBtn active={firstServe === 'B'} onClick={() => setFirstServe('B')} variant="blue">{teamB || 'Visitante'}</SelectBtn>
        </div>
      </Field>

      <Field label="Titulares en cancha">
        <div className="space-y-2">
          {starters.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="w-14 h-14 rounded-xl bg-brand-green-soft flex flex-col items-center justify-center font-bold text-brand-green flex-shrink-0">
                <div className="text-xs leading-none">{POSITION_SHORT[i]}</div>
                <div className="text-[9px] font-medium leading-none mt-0.5">{POSITION_LABELS[i]}</div>
              </div>
              <input value={p} onChange={(e) => { const np = [...starters]; np[i] = e.target.value; setStarters(np); }} maxLength={LIMITS.playerNameMax} placeholder={`Jugadora ${POSITION_LABELS[i].toLowerCase()}`} className="flex-1 p-3 bg-white border border-slate-200 rounded-xl outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/10 shadow-card transition" />
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500 mt-2">P1 saca primero. Editable después por cualquier padre.</p>
      </Field>

      <Field label={`Suplentes${bench.length > 0 ? ` (${bench.length})` : ''}`}>
        <div className="space-y-2">
          {bench.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="w-14 h-14 rounded-xl bg-slate-100 flex items-center justify-center text-slate-500 text-xs font-bold flex-shrink-0">S{i + 1}</div>
              <input value={p} onChange={(e) => { const nb = [...bench]; nb[i] = e.target.value; setBench(nb); }} maxLength={LIMITS.playerNameMax} placeholder="Nombre" className="flex-1 p-3 bg-white border border-slate-200 rounded-xl outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/10 shadow-card transition" />
              <button onClick={() => setBench(bench.filter((_, idx) => idx !== i))} className="w-10 h-10 rounded-xl bg-white border border-slate-200 text-slate-400 hover:text-red-500 transition flex items-center justify-center flex-shrink-0" aria-label="Quitar suplente">
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
        <button onClick={() => setBench([...bench, ''])} className="w-full mt-2 p-3 bg-white border-2 border-dashed border-slate-300 rounded-xl text-sm text-slate-600 font-medium flex items-center justify-center gap-1.5 hover:border-brand-green hover:text-brand-green transition">
          <Plus size={16} /> Añadir suplente
        </button>
        <p className="text-xs text-slate-500 mt-2">Opcional. Durante el partido podrás añadir más y hacer sustituciones.</p>
      </Field>

      {error && <p className="text-sm text-red-500 mb-3">{error}</p>}

      <button disabled={!canStart} onClick={handleStart} className="w-full p-4 bg-gradient-to-r from-brand-green to-brand-blue text-white disabled:from-slate-300 disabled:to-slate-300 disabled:text-slate-500 rounded-2xl font-semibold flex items-center justify-center gap-2 transition mt-4 shadow-card-md">
        <Play size={20} /> {creating ? 'Creando…' : 'Empezar partido'}
      </button>
      <p className="text-xs text-slate-500 text-center mt-3">Recibirás un enlace para compartir con el grupo de padres.</p>
    </div>
  );
}

function Field({ label, children }) {
  return <div className="mb-5"><label className="block text-xs font-semibold text-slate-700 mb-2 uppercase tracking-wide">{label}</label>{children}</div>;
}
function SelectBtn({ active, onClick, children, variant = 'green' }) {
  const activeClass = variant === 'blue'
    ? 'bg-brand-blue text-white shadow-card'
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
  const [rotationFlash, setRotationFlash] = useState(false);
  const inflight = useRef(false);
  const prevPositionsRef = useRef(null);
  const initializedRef = useRef(false);

  useEffect(() => { trackVisited(matchId); }, [matchId]);

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
        setToast({ message: '↻ Rotación aplicada', kind: 'info', key: Date.now() });
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
        showToast(`Punto ya sumado hace ${res.secondsAgo ?? 0}s por otro padre`, 'warn');
      } else {
        setMatch(res.match);
        if (res.match.finished) showToast('¡Partido finalizado y guardado!', 'success');
      }
    } catch (e) { console.error(e); showToast(e.message || 'Error al sumar punto', 'error'); }
    finally { inflight.current = false; setSyncing(false); }
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

  const handleSaveRoster = async (newPositions, newBench) => {
    setSyncing(true);
    try {
      setMatch(await updateRoster(matchId, newPositions, newBench));
      setEditingLineup(false);
      // El toast lo dispara el useEffect que detecta cambio de positions
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

  const setsA = match.sets.filter((s) => s.a > s.b).length;
  const setsB = match.sets.filter((s) => s.b > s.a).length;

  return (
    <div>
      {toast && <Toast key={toast.key} message={toast.message} kind={toast.kind} onClose={() => setToast(null)} />}

      {/* Header sticky */}
      <div className="px-5 pt-10 pb-3 sticky top-0 bg-slate-50/95 backdrop-blur-md z-10 border-b border-slate-200">
        <div className="flex items-center justify-between mb-3">
          <button onClick={() => navigate('')} className="text-brand-green flex items-center gap-1 font-medium text-sm">
            <ChevronLeft size={18} /> Inicio
          </button>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-500 uppercase tracking-wider font-bold">
              Set {match.currentSet.number} · {match.format === 'bo5' ? 'BO5' : 'BO3'}
            </span>
            {syncing && <Wifi size={12} className="text-brand-green pulse-live" />}
            {!match.finished && (
              <span className="flex items-center gap-1 text-[10px] text-red-500 font-bold">
                <span className="w-1.5 h-1.5 bg-red-500 rounded-full pulse-live" /> LIVE
              </span>
            )}
          </div>
          {!match.finished ? <button onClick={handleUndo} className="text-brand-green text-sm font-medium">Deshacer</button> : <div className="w-12" />}
        </div>

        <div className="flex items-stretch gap-2">
          <TeamHeader name={match.teamA} sets={setsA} serving={match.server === 'A' && !match.finished} color="green" />
          <div className="flex items-center text-slate-300 text-base font-bold">VS</div>
          <TeamHeader name={match.teamB} sets={setsB} serving={match.server === 'B' && !match.finished} color="blue" />
        </div>

        <MatchTimes match={match} />
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 bg-white">
        <TabBtn active={tab === 'score'} onClick={() => setTab('score')}><Trophy size={16} /> Marcador</TabBtn>
        <TabBtn active={tab === 'rotation'} onClick={() => setTab('rotation')}><Users size={16} /> Rotación</TabBtn>
      </div>

      {tab === 'score' && <ScoreTab match={match} onPoint={handleAddPoint} onEnd={handleEnd} />}
      {tab === 'rotation' && <RotationTab match={match} flash={rotationFlash} onRotate={handleRotate} onEditLineup={() => setEditingLineup(true)} />}

      <div className="px-5 mt-2"><ShareButton match={match} /></div>

      {editingLineup && (
        <RosterModal
          positions={match.positions}
          bench={match.bench || []}
          onSave={handleSaveRoster}
          onClose={() => setEditingLineup(false)}
        />
      )}
    </div>
  );
}

function TeamHeader({ name, sets, serving, color }) {
  const isGreen = color === 'green';
  const accentText = isGreen ? 'text-brand-green' : 'text-brand-blue';
  const bg = isGreen ? 'bg-brand-green-soft' : 'bg-brand-blue-soft';
  return (
    <div className={`flex-1 p-3 ${bg} rounded-2xl min-w-0`}>
      <div className="flex items-center gap-1 mb-0.5">
        {serving && <span className="text-base">🏐</span>}
        <span className="font-semibold text-slate-900 truncate text-sm">{name}</span>
      </div>
      <div className={`text-3xl font-bold tabular-nums ${accentText}`}>{sets}</div>
      <div className="text-[10px] text-slate-500 uppercase tracking-wide font-semibold">sets</div>
    </div>
  );
}

function MatchTimes({ match }) {
  const now = useNow(!match.finished);
  const end = match.endedAt || now;
  const dur = formatDuration(end - match.startedAt);
  return (
    <div className="text-[10px] text-slate-500 mt-2.5 flex items-center gap-1.5 justify-center font-medium">
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

function ScoreTab({ match, onPoint, onEnd }) {
  return (
    <div className="px-5 py-6 bg-slate-50">
      {match.finished ? (
        <FinishedSummary match={match} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <ScoreButton name={match.teamA} score={match.currentSet.a} onAdd={() => onPoint('A')} color="green" />
            <ScoreButton name={match.teamB} score={match.currentSet.b} onAdd={() => onPoint('B')} color="blue" />
          </div>
          <p className="text-[11px] text-slate-500 text-center mb-4 px-4 leading-relaxed">
            Si varios padres pulsan el mismo punto en menos de 10s, solo cuenta una vez.
          </p>
          <button onClick={onEnd} className="w-full p-3 bg-white border border-slate-200 text-slate-500 rounded-xl text-sm font-medium shadow-card">
            Finalizar partido manualmente
          </button>
        </>
      )}

      {match.sets.length > 0 && !match.finished && (
        <div className="mt-8">
          <h3 className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-3">Sets jugados</h3>
          <div className="space-y-2">
            {match.sets.map((s) => <SetRow key={s.number} set={s} teamA={match.teamA} teamB={match.teamB} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function SetRow({ set: s, teamA, teamB }) {
  const aWon = s.a > s.b;
  return (
    <div className="flex items-center justify-between p-3.5 bg-white rounded-xl border border-slate-200 shadow-card">
      <span className="text-slate-400 text-xs uppercase tracking-wide font-bold">Set {s.number}</span>
      <div className="flex items-center gap-4 font-mono font-bold text-lg">
        <span className={aWon ? 'text-brand-green' : 'text-slate-400'}>{s.a}</span>
        <span className="text-slate-300">·</span>
        <span className={!aWon ? 'text-brand-blue' : 'text-slate-400'}>{s.b}</span>
      </div>
    </div>
  );
}

function FinishedSummary({ match }) {
  const setsA = match.sets.filter((s) => s.a > s.b).length;
  const setsB = match.sets.filter((s) => s.b > s.a).length;
  const winnerName = match.winner === 'A' ? match.teamA : match.teamB;
  const winnerColor = match.winner === 'A' ? 'text-brand-green' : 'text-brand-blue';
  const duration = match.endedAt ? formatDuration(match.endedAt - match.startedAt) : null;
  return (
    <div className="px-5 py-8 bg-gradient-to-b from-brand-green-soft/40 to-transparent">
      <div className="text-center py-4">
        <Trophy size={48} className={`mx-auto mb-3 ${winnerColor}`} />
        <div className="text-xs uppercase tracking-wider text-slate-500 font-bold mb-1">Ganador</div>
        <h2 className={`text-2xl font-bold mb-2 ${winnerColor}`}>{winnerName}</h2>
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
          {match.sets.map((s) => <SetRow key={s.number} set={s} teamA={match.teamA} teamB={match.teamB} />)}
        </div>
      </div>
    </div>
  );
}

function ScoreButton({ name, score, onAdd, color }) {
  const isGreen = color === 'green';
  const bgActive = isGreen ? 'active:from-brand-green active:to-brand-green-dark' : 'active:from-brand-blue active:to-brand-blue-dark';
  const accent = isGreen ? 'text-brand-green' : 'text-brand-blue';
  return (
    <button
      onClick={onAdd}
      className={`aspect-[3/4] bg-gradient-to-br from-white to-slate-50 border border-slate-200 rounded-2xl p-4 flex flex-col justify-between shadow-card-md ${bgActive} active:text-white transition`}
    >
      <div className="text-left">
        <div className="text-[11px] text-slate-500 uppercase tracking-wider truncate font-bold">{name}</div>
      </div>
      <div className={`text-7xl font-bold text-center my-2 font-mono tabular-nums ${accent}`}>{score}</div>
      <div className={`flex items-center justify-center gap-1 ${accent} font-bold`}>
        <Plus size={18} /> <span className="text-sm">PUNTO</span>
      </div>
    </button>
  );
}

function RotationTab({ match, flash, onRotate, onEditLineup }) {
  const pos = match.positions || [];
  // Layout en rombo 3x3:
  //   .  P3 .
  //   P2 .  P4
  //   .  P1 .
  // P1 (índice 0) = saque, P2 (1) = izquierda, P3 (2) = centro, P4 (3) = derecha
  return (
    <div className="px-5 py-6 bg-slate-50">
      <div className="text-[11px] uppercase tracking-widest text-slate-400 mb-2 text-center font-bold">Red ▲</div>
      <div className={`bg-gradient-to-b from-brand-green-soft to-white border border-brand-green/20 rounded-3xl p-5 mb-6 shadow-card ${flash ? 'animate-rotation-flash' : ''}`}>
        <div className="grid grid-cols-3 gap-2">
          {/* Fila 1: solo P3 centro */}
          <div />
          <CourtCell player={pos[2]} index={2} />
          <div />
          {/* Fila 2: P2 izquierda, vacío, P4 derecha */}
          <CourtCell player={pos[1]} index={1} />
          <div className="flex items-center justify-center text-[10px] text-slate-400 font-medium">CANCHA</div>
          <CourtCell player={pos[3]} index={3} />
          {/* Fila 3: solo P1 saque */}
          <div />
          <CourtCell player={pos[0]} index={0} isServer />
          <div />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <button onClick={onRotate} className="p-4 bg-white border border-slate-200 rounded-2xl font-semibold flex items-center justify-center gap-2 shadow-card text-slate-700 active:bg-slate-100 transition">
          <RotateCw size={18} className="text-brand-green" /> Rotar
        </button>
        <button onClick={onEditLineup} className="p-4 bg-white border border-slate-200 rounded-2xl font-semibold flex items-center justify-center gap-2 shadow-card text-slate-700 active:bg-slate-100 transition">
          <Users size={18} className="text-brand-blue" /> Plantilla
        </button>
      </div>
      <p className="text-xs text-slate-500 text-center px-4 leading-relaxed">
        La rotación se aplica sola tras cada side-out y al empezar set nuevo. Cualquier padre puede rotar, sustituir o añadir suplentes.
      </p>
    </div>
  );
}

function CourtCell({ player, index, isServer = false }) {
  const label = POSITION_LABELS[index];
  return (
    <div className={`aspect-square rounded-2xl flex flex-col items-center justify-center p-2 shadow-card transition ${isServer ? 'bg-gradient-to-br from-brand-green to-brand-blue text-white' : 'bg-white border border-slate-200'}`}>
      <div className={`text-[10px] font-mono mb-1 font-bold ${isServer ? 'text-white/85' : 'text-slate-400'}`}>
        {POSITION_SHORT[index]}{isServer && ' 🏐'}
      </div>
      <div className={`text-sm font-bold text-center leading-tight truncate w-full ${isServer ? 'text-white' : 'text-slate-900'}`}>
        {player?.name || '—'}
      </div>
      <div className={`text-[9px] font-medium mt-0.5 ${isServer ? 'text-white/70' : 'text-slate-400'}`}>
        {label}
      </div>
    </div>
  );
}

// ============ MODAL PLANTILLA con sustituciones ============
function RosterModal({ positions, bench, onSave, onClose }) {
  // Estado de trabajo local: titulares + banquillo
  const [court, setCourt] = useState(positions.map((p) => ({ name: p?.name || '' })));
  const [benchList, setBench] = useState((bench || []).map((p) => ({ name: p?.name || '' })));
  const [swapping, setSwapping] = useState(null); // índice del titular que sale, o null
  const [renamingIdx, setRenamingIdx] = useState(null); // índice del titular en modo rename

  const handleSubstitute = (incomingIdx) => {
    if (swapping === null) return;
    const outgoing = court[swapping];
    const incoming = benchList[incomingIdx];
    const newCourt = [...court];
    newCourt[swapping] = incoming;
    const newBench = benchList.filter((_, i) => i !== incomingIdx);
    if (outgoing.name) newBench.push(outgoing);
    setCourt(newCourt);
    setBench(newBench);
    setSwapping(null);
  };

  const addBenchPlayer = () => setBench([...benchList, { name: '' }]);
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
    const newPositions = court.map((p, i) => ({ name: (p.name || '').trim() || POSITION_SHORT[i] }));
    const newBench = benchList.map((p) => ({ name: (p.name || '').trim() })).filter((p) => p.name);
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
          // Selector de quién entra
          <>
            <p className="text-sm text-slate-700 mb-1">Sale: <span className="font-semibold">{court[swapping]?.name || '—'}</span></p>
            <p className="text-xs text-slate-500 mb-4">¿Quién entra por {POSITION_LABELS[swapping]} ({POSITION_SHORT[swapping]})?</p>
            <div className="space-y-2 mb-3">
              {benchList.length === 0 && (
                <p className="text-sm text-slate-400 italic text-center py-6">No hay suplentes disponibles. Añade alguna en el banquillo.</p>
              )}
              {benchList.map((p, i) => (
                <button key={i} disabled={!p.name.trim()} onClick={() => handleSubstitute(i)} className="w-full p-3.5 bg-white border border-slate-200 rounded-xl text-left font-medium hover:border-brand-green hover:bg-brand-green-soft/40 disabled:opacity-40 transition flex items-center justify-between">
                  <span className="truncate">{p.name.trim() || '(sin nombre)'}</span>
                  <ChevronLeft size={16} className="rotate-180 text-slate-400" />
                </button>
              ))}
            </div>
            <button onClick={() => setSwapping(null)} className="w-full p-3 bg-slate-100 text-slate-700 rounded-xl font-medium">Cancelar</button>
          </>
        ) : (
          // Vista normal: cancha + banquillo
          <>
            <h4 className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-2">En cancha (4)</h4>
            <div className="space-y-2 mb-5">
              {court.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="w-14 h-14 rounded-xl bg-brand-green-soft flex flex-col items-center justify-center font-bold text-brand-green flex-shrink-0">
                    <div className="text-xs leading-none">{POSITION_SHORT[i]}</div>
                    <div className="text-[9px] font-medium leading-none mt-0.5">{POSITION_LABELS[i]}</div>
                  </div>
                  {renamingIdx === i ? (
                    <input
                      autoFocus
                      value={p.name}
                      onChange={(e) => updateCourtName(i, e.target.value)}
                      onBlur={() => setRenamingIdx(null)}
                      onKeyDown={(e) => e.key === 'Enter' && setRenamingIdx(null)}
                      maxLength={LIMITS.playerNameMax}
                      className="flex-1 p-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-brand-green"
                    />
                  ) : (
                    <button onClick={() => setRenamingIdx(i)} className="flex-1 p-3 bg-slate-50 border border-slate-200 rounded-xl text-left font-medium truncate">
                      {p.name || <span className="text-slate-400 italic">Sin nombre</span>}
                    </button>
                  )}
                  <button onClick={() => setSwapping(i)} className="px-3 h-12 rounded-xl bg-brand-blue-soft text-brand-blue-dark font-semibold text-sm flex items-center gap-1 flex-shrink-0">
                    <RotateCw size={14} /> Sub
                  </button>
                </div>
              ))}
            </div>

            <h4 className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-2">Banquillo ({benchList.length})</h4>
            <div className="space-y-2 mb-2">
              {benchList.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="w-14 h-14 rounded-xl bg-slate-100 flex items-center justify-center text-slate-500 text-xs font-bold flex-shrink-0">S{i + 1}</div>
                  <input
                    value={p.name}
                    onChange={(e) => updateBenchName(i, e.target.value)}
                    maxLength={LIMITS.playerNameMax}
                    placeholder="Nombre"
                    className="flex-1 p-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-brand-green"
                  />
                  <button onClick={() => removeBench(i)} className="w-10 h-10 rounded-xl bg-white border border-slate-200 text-slate-400 hover:text-red-500 transition flex items-center justify-center flex-shrink-0" aria-label="Quitar">
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
            <button onClick={addBenchPlayer} className="w-full mb-5 p-3 bg-white border-2 border-dashed border-slate-300 rounded-xl text-sm text-slate-600 font-medium flex items-center justify-center gap-1.5 hover:border-brand-green hover:text-brand-green transition">
              <Plus size={16} /> Añadir suplente
            </button>

            <button onClick={save} className="w-full p-4 bg-gradient-to-r from-brand-green to-brand-blue text-white rounded-2xl font-semibold flex items-center justify-center gap-2 shadow-card-md">
              <Check size={18} /> Guardar
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ============ HISTORY ============
function HistoryView() {
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    listMatchesByIds(getVisitedIds()).then((m) => { setMatches(m); setLoading(false); });
  }, []);
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
              {inProgress.map((m) => <MatchCard key={m.id} match={m} onClick={() => navigate(`#/match/${m.id}`)} />)}
            </div>
          )}
          {finished.length > 0 && (
            <div>
              <h2 className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-3">Finalizados</h2>
              {finished.map((m) => <MatchCard key={m.id} match={m} onClick={() => navigate(`#/match/${m.id}`)} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
