-- ============================================================================
-- MIGRATION: Ganador anticipado + cierre automático al completar formato (v1.7.1)
-- ============================================================================
-- COMPORTAMIENTO NUEVO (refinado sobre v1.7.0)
--
-- - El partido SIEMPRE se juega hasta el último set del formato:
--     BO3 → 3 sets totales (aunque uno vaya 2-0)
--     BO5 → 5 sets totales (aunque uno vaya 3-0)
-- - Cuando un equipo alcanza los sets necesarios para ganar (2 en BO3 /
--   3 en BO5), se settea winner pero el partido NO se cierra. Sigue
--   jugando "como entrenamiento" hasta el último set del formato.
-- - Cuando se completa el último set del formato (el que iguala
--   sets_total_max), el partido SE CIERRA AUTOMÁTICAMENTE (finished=TRUE,
--   ended_at=NOW). El winner se mantiene como el primer equipo que alcanzó
--   sets_needed.
-- - Ya no hace falta pulsar "Finalizar manualmente" cuando se juegan los
--   sets de cortesía: el cierre es automático al completar el formato.
--
-- IDEMPOTENTE: CREATE OR REPLACE en add_point.
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
  sets_total_max     INT;
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
  new_finished := m.finished;
  new_winner := m.winner;
  new_ended_at := m.ended_at;
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

      sets_needed    := CASE WHEN m.format = 'bo5' THEN 3 ELSE 2 END;
      sets_total_max := CASE WHEN m.format = 'bo5' THEN 5 ELSE 3 END;

      -- Si un equipo alcanza sets_needed por primera vez, se proclama
      -- ganador anticipado (winner) pero el partido NO se cierra.
      IF (sets_a >= sets_needed OR sets_b >= sets_needed) AND new_winner IS NULL THEN
        new_winner := CASE WHEN sets_a >= sets_needed THEN 'A' ELSE 'B' END;
      END IF;

      -- Si llegamos al último set del formato (3 en BO3, 5 en BO5),
      -- cerramos el partido AUTOMÁTICAMENTE.
      IF jsonb_array_length(new_sets) >= sets_total_max THEN
        new_finished := TRUE;
        new_ended_at := NOW();
        -- Por seguridad: si winner sigue null (raro pero posible si
        -- el 2-1 / 3-2 lo decide el último set), lo seteamos por
        -- comparación final de sets ganados.
        IF new_winner IS NULL THEN
          new_winner := CASE WHEN sets_a > sets_b THEN 'A'
                              WHEN sets_b > sets_a THEN 'B'
                              ELSE NULL END;
        END IF;
      ELSE
        -- Abrimos siguiente set y rotamos la formación del cole
        new_current := jsonb_build_object('a', 0, 'b', 0, 'number', current_num + 1);
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
