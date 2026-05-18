-- ============================================================================
-- MIGRATION: Reglas de rotación de minivoley (v1.6.0)
-- ============================================================================
-- REGLAS NUEVAS
--
-- 1) Recibimos → ganamos punto:
--    Side-out estándar. Si somos A (cole), rotamos formación. El sacador
--    cambia, server pasa a ser quien ganó. serve_streak = 0.
--
-- 2) Sacamos → ganamos punto:
--    Mismo jugador sigue sacando HASTA 3 puntos seguidos. Cuando ya llevamos
--    3 puntos consecutivos sacando y vamos a sumar el 4º, ANTES de sumarlo
--    rotamos la formación (el sacador cambia). serve_streak se reinicia.
--
-- 3) Sacamos → perdemos punto:
--    El rival hace side-out. server cambia, pero NUESTRA formación NO rota
--    (solo trackeamos las 4 posiciones del cole). serve_streak = 0. Aunque
--    el rival meta más puntos seguidos, nuestra formación NO rota.
--
-- IMPLEMENTACIÓN
--
-- - Nueva columna serve_streak INT DEFAULT 0 en public.matches.
-- - add_point reescrito con la lógica nueva.
-- - undo_point y subtract_point recalculan serve_streak desde el set actual.
--
-- IDEMPOTENTE: ALTER TABLE IF NOT EXISTS + CREATE OR REPLACE en funciones.
-- ============================================================================

-- ============ COLUMNA serve_streak ============
ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS serve_streak INT NOT NULL DEFAULT 0;


-- ============ FUNCIÓN add_point (v1.6.0 — reglas minivoley) ============
CREATE OR REPLACE FUNCTION public.add_point(p_match_id UUID, p_team TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  m                  public.matches;
  cs                 JSONB;
  new_a              INT;
  new_b              INT;
  set_target         INT;
  set_won            BOOLEAN;
  was_serving_a      BOOLEAN;
  is_our_serve       BOOLEAN;
  is_side_out        BOOLEAN;
  sets_a             INT;
  sets_b             INT;
  sets_needed        INT;
  new_positions      JSONB;
  new_server         TEXT;
  new_sets           JSONB;
  new_current        JSONB;
  new_finished       BOOLEAN;
  new_winner         TEXT;
  new_ended_at       TIMESTAMPTZ;
  new_serve_streak   INT;
  seconds_since      NUMERIC;
  current_num        INT;
  set_already_closed BOOLEAN;
  did_streak_rotate  BOOLEAN := FALSE;
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

  -- DEDUPE de puntos: mismo equipo, último punto hace <10s
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
  current_num := (cs->>'number')::INT;

  IF p_team = 'A' THEN new_a := new_a + 1;
  ELSE new_b := new_b + 1;
  END IF;

  was_serving_a := (m.server = 'A');
  new_positions := m.positions;
  new_server := m.server;
  new_serve_streak := COALESCE(m.serve_streak, 0);

  -- ¿El punto lo ganó el equipo que estaba sacando?
  is_our_serve := (m.server = p_team);
  is_side_out := NOT is_our_serve;

  IF is_side_out THEN
    -- El receptor anotó: side-out.
    -- Si el cole (A) ganaba el saque, rotamos su formación.
    -- El rival (B) no se rota visualmente: solo trackeamos al cole.
    IF p_team = 'A' THEN
      new_positions := jsonb_build_array(
        new_positions->3, new_positions->0, new_positions->1, new_positions->2
      );
    END IF;
    new_server := p_team;
    new_serve_streak := 0;
  ELSE
    -- El sacador ganó otro punto consecutivo. Aplicamos regla minivoley:
    -- 1, 2, 3 puntos seguidos sacando: el mismo jugador sigue sacando.
    -- Al 4º punto seguido (lo que sería streak >= 3 antes de sumar), rotamos
    -- la formación del cole (si era A) ANTES de contabilizar este punto, de
    -- modo que el nuevo sacador es quien anota este punto.
    IF new_serve_streak >= 3 THEN
      IF m.server = 'A' THEN
        new_positions := jsonb_build_array(
          new_positions->3, new_positions->0, new_positions->1, new_positions->2
        );
      END IF;
      new_serve_streak := 1;
      did_streak_rotate := TRUE;
    ELSE
      new_serve_streak := new_serve_streak + 1;
    END IF;
    -- server no cambia (el equipo sigue sacando)
  END IF;

  set_target := 25;
  set_won := (new_a >= set_target OR new_b >= set_target) AND ABS(new_a - new_b) >= 2;

  new_sets := m.sets;
  new_finished := m.finished;
  new_winner := m.winner;
  new_ended_at := m.ended_at;
  new_current := jsonb_build_object('a', new_a, 'b', new_b, 'number', current_num);

  IF set_won THEN
    -- Protección anti-duplicado: si el set con este número ya está en sets[]
    SELECT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(new_sets, '[]'::jsonb)) AS s
      WHERE (s->>'number')::INT = current_num
    ) INTO set_already_closed;

    IF NOT set_already_closed THEN
      new_sets := new_sets || jsonb_build_array(
        jsonb_build_object('a', new_a, 'b', new_b, 'number', current_num)
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
        new_current := jsonb_build_object('a', 0, 'b', 0, 'number', current_num + 1);
        -- Al empezar un set nuevo rotamos la formación del cole y reset streak
        new_positions := jsonb_build_array(
          new_positions->3, new_positions->0, new_positions->1, new_positions->2
        );
        new_serve_streak := 0;
      END IF;
    END IF;
  END IF;

  UPDATE public.matches SET
    current_set   = new_current,
    sets          = new_sets,
    positions     = new_positions,
    server        = new_server,
    serve_streak  = new_serve_streak,
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


-- ============ FUNCIÓN subtract_point (v1.6.0) ============
-- Resta un punto al equipo indicado del set actual y resetea serve_streak
-- de forma conservadora (volver al estado exacto previo es complejo, así que
-- ponemos serve_streak = 0; el contador se reconstruye con el siguiente punto).
CREATE OR REPLACE FUNCTION public.subtract_point(p_match_id UUID, p_team TEXT)
RETURNS public.matches
LANGUAGE plpgsql
AS $$
DECLARE
  m         public.matches;
  cs        JSONB;
  cur_a     INT;
  cur_b     INT;
  new_cs    JSONB;
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

  cs := m.current_set;
  cur_a := (cs->>'a')::INT;
  cur_b := (cs->>'b')::INT;

  IF p_team = 'A' AND cur_a > 0 THEN
    cur_a := cur_a - 1;
  ELSIF p_team = 'B' AND cur_b > 0 THEN
    cur_b := cur_b - 1;
  ELSE
    -- nada que restar
    RETURN m;
  END IF;

  new_cs := jsonb_build_object('a', cur_a, 'b', cur_b, 'number', (cs->>'number')::INT);

  UPDATE public.matches SET
    current_set  = new_cs,
    serve_streak = 0,  -- reset conservador; se reconstruye con próximos puntos
    last_point_at = NULL  -- libera el dedupe de 10s
  WHERE id = p_match_id
  RETURNING * INTO m;

  RETURN m;
END;
$$;

GRANT EXECUTE ON FUNCTION public.subtract_point(UUID, TEXT) TO authenticated, anon;


-- ============ FUNCIÓN undo_point (v1.6.0) ============
-- Deshace el último punto del set actual. Si el set estaba a 0-0 y ya había
-- sets previos, no hace nada. serve_streak se resetea (igual que subtract).
CREATE OR REPLACE FUNCTION public.undo_point(p_match_id UUID)
RETURNS public.matches
LANGUAGE plpgsql
AS $$
DECLARE
  m       public.matches;
  cs      JSONB;
  a       INT;
  b       INT;
  last_t  TEXT;
  new_cs  JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO m FROM public.matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Match not found' USING ERRCODE = 'P0002';
  END IF;

  cs := m.current_set;
  a := (cs->>'a')::INT;
  b := (cs->>'b')::INT;
  last_t := m.last_point_by;

  IF last_t IS NULL OR (a = 0 AND b = 0) THEN
    RETURN m;
  END IF;

  IF last_t = 'A' AND a > 0 THEN
    a := a - 1;
  ELSIF last_t = 'B' AND b > 0 THEN
    b := b - 1;
  END IF;

  new_cs := jsonb_build_object('a', a, 'b', b, 'number', (cs->>'number')::INT);

  UPDATE public.matches SET
    current_set   = new_cs,
    serve_streak  = 0,
    last_point_at = NULL,
    last_point_by = NULL
  WHERE id = p_match_id
  RETURNING * INTO m;

  RETURN m;
END;
$$;

GRANT EXECUTE ON FUNCTION public.undo_point(UUID) TO authenticated, anon;
