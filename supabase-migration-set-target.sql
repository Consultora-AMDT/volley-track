-- ============================================================================
-- MIGRATION: Target del set configurable (v1.9.18)
-- ============================================================================
-- CAMBIO
--
-- Hasta ahora el set se cerraba siempre al alcanzar 25 puntos con ventaja
-- de 2 (regla estándar de voley). Ahora ese target es configurable por
-- partido: 12, 15 o 25 puntos. Útil porque las categorías de mini-voley
-- juegan a 25 pero en algunos partidos amistosos / entrenamiento se
-- usan sets más cortos.
--
-- CAMBIOS DE BD
--
-- 1) Nueva columna public.matches.set_target INT NOT NULL DEFAULT 25.
--    NOT NULL con default permite que partidos existentes (creados antes
--    de esta migración) queden automáticamente con set_target=25 sin
--    romper nada.
--
-- 2) Función add_point: en lugar de `set_target := 25;` hardcodeado,
--    leemos `m.set_target`. Si por algún motivo la fila tuviera NULL
--    (no debería con el default), caemos a 25.
--
-- IDEMPOTENTE: CREATE OR REPLACE en add_point. La función es idéntica a
-- la de v1.9.17 (rotate-after-3-points) salvo en esa línea.
-- ============================================================================

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS set_target INT NOT NULL DEFAULT 25;

-- Restricción de valores válidos (CHECK constraint). Si ya existe la
-- saltamos por simplicidad.
DO $$ BEGIN
  ALTER TABLE public.matches
    ADD CONSTRAINT matches_set_target_check
    CHECK (set_target IN (12, 15, 25));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============ FUNCIÓN add_point ACTUALIZADA ============

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

  is_our_serve := (m.server = p_team);
  is_side_out := NOT is_our_serve;

  IF is_side_out THEN
    -- El receptor anotó (side-out). Si el cole (A) recupera el saque
    -- rotamos su formación; el de P4 entra a P1 a sacar.
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

  -- Target del set leído desde la fila. Default 25 si fuera NULL.
  set_target := COALESCE(m.set_target, 25);
  set_won := (new_a >= set_target OR new_b >= set_target) AND ABS(new_a - new_b) >= 2;

  new_sets := m.sets;
  new_finished := m.finished;
  new_winner := m.winner;
  new_ended_at := m.ended_at;
  new_current := jsonb_build_object('a', new_a, 'b', new_b, 'number', current_num);

  IF set_won THEN
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

      IF (sets_a >= sets_needed OR sets_b >= sets_needed) AND new_winner IS NULL THEN
        new_winner := CASE WHEN sets_a >= sets_needed THEN 'A' ELSE 'B' END;
      END IF;

      IF jsonb_array_length(new_sets) >= sets_total_max THEN
        new_finished := TRUE;
        new_ended_at := NOW();
        IF new_winner IS NULL THEN
          new_winner := CASE WHEN sets_a > sets_b THEN 'A'
                              WHEN sets_b > sets_a THEN 'B'
                              ELSE NULL END;
        END IF;
      ELSE
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
