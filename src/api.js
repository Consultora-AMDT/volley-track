import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storage: localStorage },
      realtime: { params: { eventsPerSecond: 10 } },
    })
  : null;

// ============ AUTH ============
export async function ensureAuth() {
  if (!supabase) throw new Error('Supabase no configurado');
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) return session.user.id;
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return data.user.id;
}

export function onAuthChange(callback) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user?.id || null);
  });
  return () => data.subscription.unsubscribe();
}

// ============ MAPEO ============
function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdBy: row.created_by,
    teamA: row.team_a,
    teamB: row.team_b,
    location: row.location,
    format: row.format,
    startedAt: new Date(row.started_at).getTime(),
    endedAt: row.ended_at ? new Date(row.ended_at).getTime() : null,
    finished: row.finished,
    winner: row.winner,
    server: row.server,
    currentSet: row.current_set,
    sets: row.sets,
    positions: row.positions,
    lastPointBy: row.last_point_by,
    lastPointAt: row.last_point_at ? new Date(row.last_point_at).getTime() : null,
    updatedAt: new Date(row.updated_at).getTime(),
  };
}

// ============ CRUD ============
export async function createMatch(config, userId) {
  const positions =
    config.players.length === 6
      ? config.players.map((name, i) => ({ name, number: i + 1 }))
      : [1, 2, 3, 4, 5, 6].map((n) => ({ name: `J${n}`, number: n }));

  const payload = {
    created_by: userId,
    team_a: config.teamA,
    team_b: config.teamB,
    location: config.location || null,
    format: config.format,
    server: config.firstServe,
    current_set: { a: 0, b: 0, number: 1 },
    sets: [],
    positions,
    finished: false,
    started_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('matches').insert(payload).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function getMatch(id) {
  const { data, error } = await supabase
    .from('matches').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return fromRow(data);
}

export async function listMatchesByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const { data, error } = await supabase
    .from('matches').select('*').in('id', ids);
  if (error) throw error;
  return (data || []).map(fromRow).sort((a, b) => b.startedAt - a.startedAt);
}

// ============ ACCIONES ============
// Estas tres pasan por RPC para garantizar atomicidad y dedupe server-side.
export async function addPoint(matchId, team) {
  const { data, error } = await supabase.rpc('add_point', {
    p_match_id: matchId, p_team: team,
  });
  if (error) throw error;
  return {
    match: fromRow(data.match),
    deduped: data.deduped === true,
    secondsAgo: data.seconds_ago ?? null,
  };
}

export async function undoPoint(matchId) {
  const { data, error } = await supabase.rpc('undo_point', { p_match_id: matchId });
  if (error) throw error;
  return fromRow(data);
}

// Rotación manual y editar plantilla → UPDATE directo (RLS permite a cualquier auth user).
export async function rotatePositions(matchId, currentPositions) {
  const [p1, ...rest] = currentPositions;
  const rotated = [...rest, p1];
  const { data, error } = await supabase
    .from('matches').update({ positions: rotated }).eq('id', matchId).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function updateLineup(matchId, positions) {
  const { data, error } = await supabase
    .from('matches').update({ positions }).eq('id', matchId).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function finishMatch(matchId) {
  const { data, error } = await supabase
    .from('matches').update({ finished: true, ended_at: new Date().toISOString() })
    .eq('id', matchId).select().single();
  if (error) throw error;
  return fromRow(data);
}

// ============ REALTIME ============
export function subscribeToMatch(id, callback) {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`match:${id}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'matches', filter: `id=eq.${id}` },
      (payload) => callback(fromRow(payload.new))
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}
