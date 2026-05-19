-- ============================================================================
-- MIGRATION: Ganador sin finalizar (v1.7.0)
-- ============================================================================
-- COMPORTAMIENTO NUEVO
--
-- Aunque un equipo alcance los sets necesarios (2 en BO3 / 3 en BO5) para
-- ganar el partido, el partido NO se da por finalizado automáticamente.
-- En el cole se sigue jugando un set extra "como entrenamiento". El partido
-- solo se cierra cuando alguien pulsa "Finalizar partido manualmente".
--
-- CAMBIOS
-- - add_point: cuando se alcanza sets_needed, settea winner pero deja
--   finished = FALSE y ended_at = NULL. Continúa abriendo el siguiente set
--   normalmente (incluso pasando del límite del formato — BO3 puede tener
--   set 4, 5, etc.).
-- - El cliente detecta winner != NULL && finished == FALSE para mostrar un
--   banner "Ganador del partido — sigue jugándose".
--
-- IDEMPOTENTE: CREATE OR REPLACE en add_point. subtract_point y undo_point
-- no cambian (siguen tal cual quedaron en la v1.6.0).
-- ============================================================================

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
    -- Side-out. Si el cole (A) ganó saque, rotamos su formación.
    IF p_team = 'A' THEN
      new_positions := jsonb_build_array(
        new_positions->3, new_positions->0, new_positions->1, new_positions->2
      );
    END IF;
    new_server := p_team;
    new_serve_streak := 0;
  ELSE
    -- El sacador ganó otro punto consecutivo.
    -- Regla minivoley: máximo 3 saques seguidos sin rotar.
    IF new_serve_streak >= 3 THEN
      IF m.server = 'A' THEN
        new_positions := jsonb_build_array(
          new_positions->3, new_positions->0, new_positions->1, new_positions->2
        );
      END IF;
      new_serve_streak := 1;
    ELSE
      new_serve_streak := new_serve_streak + 1;
    END IF;
  END IF;

  set_target := 25;
  set_won := (new_a >= set_target OR new_b >= set_target) AND ABS(new_a - new_b) >= 2;

  new_sets := m.sets;
  -- NUEVO: NUNCA se marca finished automáticamente. El partido sigue activo
  -- aunque se alcance sets_needed. Solo "Finalizar manualmente" cierra el match.
  new_finished := m.finished;       -- preservar (siempre será FALSE aquí)
  new_winner := m.winner;            -- preservar; solo se actualiza si nuevo
  new_ended_at := m.ended_at;        -- preservar
  new_current := jsonb_build_object('a', new_a, 'b', new_b, 'number', current_num);

  IF set_won THEN
    -- Protección anti-duplicado de set
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

      -- CAMBIO CLAVE v1.7.0: si se alcanza sets_needed, solo seteamos winner
      -- (la primera vez que se alcanza). NO marcamos finished. El partido
      -- continúa abierto, abriendo el siguiente set como cualquier otro.
      IF (sets_a >= sets_needed OR sets_b >= sets_needed) AND new_winner IS NULL THEN
        new_winner := CASE WHEN sets_a >= sets_needed THEN 'A' ELSE 'B' END;
      END IF;

      -- En todos los casos donde se cierra un set, abrimos el siguiente
      -- (no hay "fin de partido" automático ya).
      new_current := jsonb_build_object('a', 0, 'b', 0, 'number', current_num + 1);
      new_positions := jsonb_build_array(
        new_positions->3, new_positions->0, new_positions->1, new_positions->2
      );
      new_serve_streak := 0;
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
