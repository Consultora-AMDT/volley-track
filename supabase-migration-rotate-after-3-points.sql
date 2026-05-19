-- ============================================================================
-- MIGRATION: Rotación tras 3 puntos consecutivos (v1.9.17)
-- ============================================================================
-- CAMBIO DE REGLA
--
-- Antes (v1.7.1+): el sacador podía hacer hasta 4 saques consecutivos.
--   Al ganar el 4º punto seguido, rotaba la formación. El 5º saque era
--   de la nueva jugadora.
--     Saque 1 → X  (streak: 0→1)
--     Saque 2 → X  (streak: 1→2)
--     Saque 3 → X  (streak: 2→3)
--     Saque 4 → X  (streak: 3 → ROTA → 1) ← rota TRAS este saque
--     Saque 5 → nueva jugadora
--
-- Ahora (v1.9.17): el sacador hace MÁXIMO 3 saques consecutivos. Tras
--   el 3º punto consecutivo, rota la formación. El 4º saque es de la
--   nueva jugadora.
--     Saque 1 → X  (streak: 0→1)
--     Saque 2 → X  (streak: 1→2)
--     Saque 3 → X  (streak: 2 → ROTA → 1) ← rota TRAS este saque
--     Saque 4 → nueva jugadora
--
-- Esta regla coincide con la federación habitual en mini-voley para
-- evitar que un solo sacador fuerte domine el partido.
--
-- CAMBIO DE CÓDIGO
--   `IF new_serve_streak >= 3 THEN`  →  `IF new_serve_streak >= 2 THEN`
--
-- IDEMPOTENTE: CREATE OR REPLACE en add_point. La función es identica a
-- la de v1.7.1 (supabase-migration-winner-auto-finish.sql) salvo en esa
-- línea.
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
    -- streak previo >= 2 significa que ya hubo 2 saques exitosos y este
    -- (el 3º) cierra la racha. Rotamos formación, el siguiente sacador
    -- es la jugadora siguiente.
    IF new_serve_streak >= 2 THEN
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
