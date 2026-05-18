-- ============================================================================
-- MIGRATION: Fix duplicate-set bug (v1.4.3)
-- ============================================================================
-- PROBLEMA
--   En "Mis partidos guardados" un set aparece duplicado (por ejemplo set 3
--   listado dos veces) tras reabrir un partido finalizado.
--
-- CAUSA RAÍZ
--   reopenMatch (cliente) hacía un UPDATE simple poniendo finished=false
--   pero dejando current_set con el marcador que cerró el partido (p.ej.
--   25-22 número=3). Al pulsar el siguiente +PUNTO, add_point evaluaba
--   set_won = TRUE de nuevo (porque 25 ≥ 25 con diff ≥ 2) y APPENDeaba
--   otra vez el set ya cerrado al array sets[].
--
-- ARREGLO
--   1) add_point ahora comprueba que no exista ya un set con el mismo
--      number antes de añadir. Si ya está cerrado, no lo duplica.
--   2) Nuevo RPC reopen_match: si el último set en sets[] coincide en
--      number con current_set, lo retira y resta un punto al ganador
--      para que se pueda volver a jugar sin re-cerrarse inmediatamente.
--   3) Nuevo RPC dedupe_match_sets: limpia partidos ya corruptos
--      colapsando entradas con el mismo number (deja la última de cada
--      número, ordenadas ascendentemente) y recalcula finished/winner.
--
-- IDEMPOTENTE: CREATE OR REPLACE en todo. Se puede re-ejecutar sin pasar nada.
-- ============================================================================

-- ============ FUNCIÓN add_point (versión 1.4.3 — anti-duplicado) ============
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

  -- Side-out: si el receptor anota, rota y pasa el saque
  was_serving_a := (m.server = 'A');
  new_positions := m.positions;
  new_server := m.server;

  IF p_team = 'A' AND NOT was_serving_a THEN
    new_positions := jsonb_build_array(
      new_positions->3, new_positions->0, new_positions->1, new_positions->2
    );
    new_server := 'A';
  ELSIF p_team = 'B' AND was_serving_a THEN
    new_server := 'B';
  END IF;

  set_target := 25;
  set_won := (new_a >= set_target OR new_b >= set_target) AND ABS(new_a - new_b) >= 2;

  new_sets := m.sets;
  new_finished := m.finished;
  new_winner := m.winner;
  new_ended_at := m.ended_at;
  new_current := jsonb_build_object('a', new_a, 'b', new_b, 'number', current_num);

  IF set_won THEN
    -- PROTECCIÓN ANTI-DUPLICADO: ¿el set con este número YA está en sets[]?
    -- Si lo está, no lo duplicamos. Solo actualizamos el currentSet.
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
        new_positions := jsonb_build_array(
          new_positions->3, new_positions->0, new_positions->1, new_positions->2
        );
      END IF;
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


-- ============ FUNCIÓN reopen_match (v1.4.3) ============
-- Reabre un partido finalizado. Si el último set en sets[] coincide en
-- number con current_set, lo retira y resta un punto al equipo ganador
-- para que el set pueda continuar sin re-cerrarse al primer punto.
CREATE OR REPLACE FUNCTION public.reopen_match(p_match_id UUID)
RETURNS public.matches
LANGUAGE plpgsql
AS $$
DECLARE
  m          public.matches;
  cs_number  INT;
  last_set   JSONB;
  new_sets   JSONB;
  last_a     INT;
  last_b     INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO m FROM public.matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Match not found' USING ERRCODE = 'P0002';
  END IF;

  cs_number := (m.current_set->>'number')::INT;
  new_sets := COALESCE(m.sets, '[]'::jsonb);

  IF jsonb_array_length(new_sets) > 0 THEN
    last_set := new_sets->(jsonb_array_length(new_sets) - 1);
    IF (last_set->>'number')::INT = cs_number THEN
      new_sets := new_sets - (jsonb_array_length(new_sets) - 1);
      last_a := (last_set->>'a')::INT;
      last_b := (last_set->>'b')::INT;

      IF last_a > last_b THEN
        last_a := last_a - 1;
      ELSE
        last_b := last_b - 1;
      END IF;

      UPDATE public.matches SET
        finished    = FALSE,
        winner      = NULL,
        ended_at    = NULL,
        sets        = new_sets,
        current_set = jsonb_build_object('a', last_a, 'b', last_b, 'number', cs_number)
      WHERE id = p_match_id
      RETURNING * INTO m;

      RETURN m;
    END IF;
  END IF;

  -- Caso por defecto: el último set y currentSet no coinciden, así que solo
  -- marcamos el partido como abierto sin tocar marcador.
  UPDATE public.matches SET
    finished = FALSE,
    winner   = NULL,
    ended_at = NULL
  WHERE id = p_match_id
  RETURNING * INTO m;

  RETURN m;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reopen_match(UUID) TO authenticated, anon;


-- ============ FUNCIÓN dedupe_match_sets (v1.4.3) ============
-- Limpia un partido cuyo array sets[] tiene entradas duplicadas por number.
-- Deja una sola entrada por número (la última que aparece, suele ser la
-- más actualizada) ordenadas ascendentemente. Recalcula finished/winner.
CREATE OR REPLACE FUNCTION public.dedupe_match_sets(p_match_id UUID)
RETURNS public.matches
LANGUAGE plpgsql
AS $$
DECLARE
  m            public.matches;
  s            JSONB;
  num          INT;
  agg          JSONB := '{}'::jsonb;
  cleaned      JSONB := '[]'::jsonb;
  k            TEXT;
  sets_a       INT;
  sets_b       INT;
  sets_needed  INT;
  total_after  INT;
  total_before INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO m FROM public.matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Match not found' USING ERRCODE = 'P0002';
  END IF;

  total_before := jsonb_array_length(COALESCE(m.sets, '[]'::jsonb));

  -- Recorremos sets[] guardando en agg{number -> set}. Como JSONB
  -- concatenación con misma clave PISA, nos quedamos con la última.
  FOR s IN SELECT * FROM jsonb_array_elements(COALESCE(m.sets, '[]'::jsonb))
  LOOP
    num := (s->>'number')::INT;
    agg := agg || jsonb_build_object(num::TEXT, s);
  END LOOP;

  -- Reconstruimos array ordenado por number ascendente
  FOR k IN
    SELECT key FROM jsonb_each(agg) ORDER BY (key)::INT ASC
  LOOP
    cleaned := cleaned || jsonb_build_array(agg->k);
  END LOOP;

  total_after := jsonb_array_length(cleaned);

  -- Recalcular finished/winner por si la limpieza cambia el resultado
  SELECT
    COUNT(*) FILTER (WHERE (s->>'a')::INT > (s->>'b')::INT),
    COUNT(*) FILTER (WHERE (s->>'b')::INT > (s->>'a')::INT)
  INTO sets_a, sets_b
  FROM jsonb_array_elements(cleaned) s;

  sets_needed := CASE WHEN m.format = 'bo5' THEN 3 ELSE 2 END;

  UPDATE public.matches SET
    sets     = cleaned,
    finished = (sets_a >= sets_needed OR sets_b >= sets_needed),
    winner   = CASE
                 WHEN sets_a >= sets_needed THEN 'A'
                 WHEN sets_b >= sets_needed THEN 'B'
                 ELSE NULL
               END,
    ended_at = CASE
                 WHEN sets_a >= sets_needed OR sets_b >= sets_needed
                      THEN COALESCE(m.ended_at, NOW())
                 ELSE NULL
               END
  WHERE id = p_match_id
  RETURNING * INTO m;

  RAISE NOTICE 'dedupe_match_sets: % -> % entries', total_before, total_after;
  RETURN m;
END;
$$;

GRANT EXECUTE ON FUNCTION public.dedupe_match_sets(UUID) TO authenticated, anon;


-- ============ FIX AUTOMÁTICO DE TODOS LOS PARTIDOS YA CORRUPTOS ============
-- Lógica inline (no llama a dedupe_match_sets para no exigir auth.uid()
-- desde el SQL editor de Supabase). Detecta partidos cuyo sets[] tiene
-- duplicados por number y los colapsa.
DO $$
DECLARE
  rec          RECORD;
  s            JSONB;
  num          INT;
  agg          JSONB;
  cleaned      JSONB;
  k            TEXT;
  sets_a       INT;
  sets_b       INT;
  sets_needed  INT;
  total_fixed  INT := 0;
BEGIN
  FOR rec IN
    SELECT id, sets, format, ended_at FROM public.matches
    WHERE sets IS NOT NULL
      AND jsonb_array_length(sets) > 0
      AND (
        SELECT COUNT(DISTINCT (s2->>'number')::INT)
        FROM jsonb_array_elements(sets) s2
      ) < jsonb_array_length(sets)
  LOOP
    agg := '{}'::jsonb;
    cleaned := '[]'::jsonb;

    FOR s IN SELECT * FROM jsonb_array_elements(rec.sets)
    LOOP
      num := (s->>'number')::INT;
      agg := agg || jsonb_build_object(num::TEXT, s);
    END LOOP;

    FOR k IN SELECT key FROM jsonb_each(agg) ORDER BY (key)::INT ASC
    LOOP
      cleaned := cleaned || jsonb_build_array(agg->k);
    END LOOP;

    SELECT
      COUNT(*) FILTER (WHERE (s3->>'a')::INT > (s3->>'b')::INT),
      COUNT(*) FILTER (WHERE (s3->>'b')::INT > (s3->>'a')::INT)
    INTO sets_a, sets_b
    FROM jsonb_array_elements(cleaned) s3;

    sets_needed := CASE WHEN rec.format = 'bo5' THEN 3 ELSE 2 END;

    UPDATE public.matches SET
      sets     = cleaned,
      finished = (sets_a >= sets_needed OR sets_b >= sets_needed),
      winner   = CASE
                   WHEN sets_a >= sets_needed THEN 'A'
                   WHEN sets_b >= sets_needed THEN 'B'
                   ELSE NULL
                 END,
      ended_at = CASE
                   WHEN sets_a >= sets_needed OR sets_b >= sets_needed
                        THEN COALESCE(rec.ended_at, NOW())
                   ELSE NULL
                 END
    WHERE id = rec.id;

    total_fixed := total_fixed + 1;
  END LOOP;
  RAISE NOTICE 'Partidos limpiados de duplicados: %', total_fixed;
END $$;
