-- VolleyTrack: esquema Supabase v2 (edición colaborativa + dedupe 10s)
-- Ejecuta en SQL Editor de Supabase. Es idempotente: puedes re-ejecutarlo sin problema.

-- ============ TABLA ============
CREATE TABLE IF NOT EXISTS public.matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  team_a TEXT NOT NULL CHECK (char_length(team_a) BETWEEN 1 AND 60),
  team_b TEXT NOT NULL CHECK (char_length(team_b) BETWEEN 1 AND 60),
  location TEXT CHECK (char_length(location) <= 80),
  format TEXT NOT NULL CHECK (format IN ('bo3', 'bo5')),

  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  finished BOOLEAN NOT NULL DEFAULT FALSE,
  winner TEXT CHECK (winner IN ('A', 'B')),
  server TEXT NOT NULL CHECK (server IN ('A', 'B')),

  current_set JSONB NOT NULL DEFAULT '{"a":0,"b":0,"number":1}'::jsonb,
  sets JSONB NOT NULL DEFAULT '[]'::jsonb,
  positions JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_point_by TEXT CHECK (last_point_by IN ('A', 'B'))
);

-- Migración: añadir last_point_at si no existía
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS last_point_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS matches_created_by_idx ON public.matches (created_by);
CREATE INDEX IF NOT EXISTS matches_started_at_idx ON public.matches (started_at DESC);

-- ============ TRIGGER updated_at ============
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS matches_set_updated_at ON public.matches;
CREATE TRIGGER matches_set_updated_at
  BEFORE UPDATE ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ RLS — modelo colaborativo ============
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "matches_select" ON public.matches;
CREATE POLICY "matches_select" ON public.matches FOR SELECT USING (true);

DROP POLICY IF EXISTS "matches_insert" ON public.matches;
CREATE POLICY "matches_insert" ON public.matches FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = created_by);

-- IMPORTANTE: cualquier usuario autenticado (incluido anonymous) puede editar
-- el partido. Antes era restrictivo al creador.
DROP POLICY IF EXISTS "matches_update" ON public.matches;
DROP POLICY IF EXISTS "matches_update_owner" ON public.matches;
DROP POLICY IF EXISTS "matches_update_any" ON public.matches;
CREATE POLICY "matches_update_any" ON public.matches FOR UPDATE
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

-- Borrar sigue siendo solo del creador (evita que cualquier padre cargue el partido)
DROP POLICY IF EXISTS "matches_delete" ON public.matches;
CREATE POLICY "matches_delete" ON public.matches FOR DELETE
  USING (auth.uid() = created_by);

-- ============ REALTIME ============
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.matches;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

-- ============ FUNCIÓN add_point con DEDUPE 10s ============
-- Función atómica: bloquea la fila (FOR UPDATE), comprueba si el mismo equipo
-- anotó en los últimos 10s y, si no, aplica la lógica de voleibol completa
-- (puntuación, side-out, rotación, cierre de set, cierre de partido).
CREATE OR REPLACE FUNCTION public.add_point(p_match_id UUID, p_team TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  m              public.matches;
  cs             JSONB;
  new_a          INT;
  new_b          INT;
  set_target     INT;
  set_won        BOOLEAN;
  was_serving_a  BOOLEAN;
  sets_a         INT;
  sets_b         INT;
  sets_needed    INT;
  new_positions  JSONB;
  new_server     TEXT;
  new_sets       JSONB;
  new_current    JSONB;
  new_finished   BOOLEAN;
  new_winner     TEXT;
  new_ended_at   TIMESTAMPTZ;
  seconds_since  NUMERIC;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'P0001';
  END IF;
  IF p_team NOT IN ('A', 'B') THEN
    RAISE EXCEPTION 'Invalid team' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO m FROM public.matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Match not found' USING ERRCODE = 'P0002';
  END IF;
  IF m.finished THEN
    RETURN jsonb_build_object('match', to_jsonb(m), 'deduped', false);
  END IF;

  -- DEDUPE: mismo equipo, último punto hace <10s → no se aplica
  IF m.last_point_at IS NOT NULL
     AND m.last_point_by = p_team
     AND NOW() - m.last_point_at < INTERVAL '10 seconds' THEN
    seconds_since := EXTRACT(EPOCH FROM (NOW() - m.last_point_at));
    RETURN jsonb_build_object(
      'match', to_jsonb(m),
      'deduped', true,
      'seconds_ago', ROUND(seconds_since)::INT
    );
  END IF;

  cs := m.current_set;
  new_a := (cs->>'a')::INT;
  new_b := (cs->>'b')::INT;

  IF p_team = 'A' THEN new_a := new_a + 1;
  ELSE new_b := new_b + 1;
  END IF;

  -- Side-out: si el receptor anota, rota y pasa el saque
  was_serving_a := (m.server = 'A');
  new_positions := m.positions;
  new_server := m.server;

  IF p_team = 'A' AND NOT was_serving_a THEN
    new_positions := jsonb_build_array(
      new_positions->1, new_positions->2, new_positions->3,
      new_positions->4, new_positions->5, new_positions->0
    );
    new_server := 'A';
  ELSIF p_team = 'B' AND was_serving_a THEN
    new_server := 'B';
  END IF;

  -- Punto objetivo del set
  IF (m.format = 'bo5' AND (cs->>'number')::INT = 5)
     OR (m.format = 'bo3' AND (cs->>'number')::INT = 3) THEN
    set_target := 15;
  ELSE
    set_target := 25;
  END IF;

  set_won := (new_a >= set_target OR new_b >= set_target) AND ABS(new_a - new_b) >= 2;

  new_sets := m.sets;
  new_finished := m.finished;
  new_winner := m.winner;
  new_ended_at := m.ended_at;
  new_current := jsonb_build_object('a', new_a, 'b', new_b, 'number', (cs->>'number')::INT);

  IF set_won THEN
    new_sets := new_sets || jsonb_build_array(
      jsonb_build_object('a', new_a, 'b', new_b, 'number', (cs->>'number')::INT)
    );

    SELECT
      COUNT(*) FILTER (WHERE (s->>'a')::INT > (s->>'b')::INT),
      COUNT(*) FILTER (WHERE (s->>'b')::INT > (s->>'a')::INT)
    INTO sets_a, sets_b
    FROM jsonb_array_elements(new_sets) s;

    sets_needed := CASE WHEN m.format = 'bo5' THEN 3 ELSE 2 END;

    IF sets_a >= sets_needed OR sets_b >= sets_needed THEN
      new_finished := TRUE;
      new_winner := CASE WHEN sets_a >= sets_needed THEN 'A' ELSE 'B' END;
      new_ended_at := NOW();
    ELSE
      new_current := jsonb_build_object('a', 0, 'b', 0, 'number', (cs->>'number')::INT + 1);
      new_positions := jsonb_build_array(
        new_positions->1, new_positions->2, new_positions->3,
        new_positions->4, new_positions->5, new_positions->0
      );
    END IF;
  END IF;

  UPDATE public.matches SET
    current_set   = new_current,
    sets          = new_sets,
    positions     = new_positions,
    server        = new_server,
    last_point_by = p_team,
    last_point_at = NOW(),
    finished      = new_finished,
    winner        = new_winner,
    ended_at      = new_ended_at
  WHERE id = p_match_id
  RETURNING * INTO m;

  RETURN jsonb_build_object('match', to_jsonb(m), 'deduped', false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_point(UUID, TEXT) TO authenticated, anon;

-- ============ FUNCIÓN undo_point ============
-- Deshace el último punto (cualquier usuario, sin ventana de dedupe).
CREATE OR REPLACE FUNCTION public.undo_point(p_match_id UUID)
RETURNS public.matches
LANGUAGE plpgsql
AS $$
DECLARE
  m   public.matches;
  cs  JSONB;
  a   INT;
  b   INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO m FROM public.matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Match not found'; END IF;
  IF m.last_point_by IS NULL THEN RETURN m; END IF;

  cs := m.current_set;
  a := (cs->>'a')::INT;
  b := (cs->>'b')::INT;

  IF m.last_point_by = 'A' AND a > 0 THEN a := a - 1;
  ELSIF m.last_point_by = 'B' AND b > 0 THEN b := b - 1;
  END IF;

  UPDATE public.matches SET
    current_set   = jsonb_build_object('a', a, 'b', b, 'number', (cs->>'number')::INT),
    last_point_by = NULL,
    last_point_at = NULL
  WHERE id = p_match_id
  RETURNING * INTO m;

  RETURN m;
END;
$$;

GRANT EXECUTE ON FUNCTION public.undo_point(UUID) TO authenticated, anon;

-- ============ NOTAS ============
-- Modelo de seguridad colaborativo:
--   * Cualquier padre con auth anónima puede SELECT, INSERT (como sí mismo), UPDATE
--   * DELETE sigue restringido al creador
--   * Las RPC son las únicas operaciones recomendadas para puntos (atomicidad + dedupe)
--   * RLS no bloquea UPDATEs directos: confiamos en el cliente para usar las RPC
--   * Para auditoría futura se puede añadir tabla matches_events con quien hizo qué
