-- ============================================================================
-- v1.9.1 — Anti-doble-pulsación al RESTAR PUNTO
-- ============================================================================
-- Hasta v1.9.0, el RPC subtract_point solo deduplicaba sumas (add_point).
-- Si dos padres/madres viendo el partido pulsaban "- Restar punto" a la
-- vez (típicamente para corregir un punto sumado por error), AMBAS
-- restas se aplicaban → terminaba quitando 2 puntos en lugar de 1.
--
-- Esta migración añade una ventana de 10s también a subtract_point con
-- el MISMO patrón que add_point: si la última resta sobre el mismo
-- equipo fue hace menos de 10s, se ignora la nueva pulsación y se
-- devuelve {deduped:true, seconds_ago:N}.
--
-- IDEMPOTENTE: se pueden añadir las columnas y sobrescribir la función
-- varias veces sin efectos colaterales.
-- ============================================================================

-- ============ Columnas para trackear última resta ============
-- Mantenemos last_subtract_* separado de last_point_* porque son acciones
-- distintas: sumar y restar deben deduparse cada una por su lado. Si una
-- persona suma y otra resta el mismo equipo (acciones opuestas), ambas
-- deben aplicarse normalmente; el dedupe solo opera sobre acciones del
-- mismo tipo.
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS last_subtract_by TEXT;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS last_subtract_at TIMESTAMPTZ;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS last_subtract_user UUID;

-- Constraint suave: last_subtract_by, si está, debe ser 'A' o 'B'.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'matches_last_subtract_by_check'
  ) THEN
    ALTER TABLE public.matches
      ADD CONSTRAINT matches_last_subtract_by_check
      CHECK (last_subtract_by IS NULL OR last_subtract_by IN ('A', 'B'));
  END IF;
END $$;

-- ============ FUNCIÓN subtract_point con dedupe ============
-- IMPORTANTE: la función original devolvía `matches` (la row) y la
-- nueva devuelve `JSONB`. PostgreSQL no permite cambiar el tipo de
-- retorno con CREATE OR REPLACE, así que hay que DROP primero. El
-- DROP IF EXISTS hace que sea seguro ejecutar la migración varias
-- veces.
DROP FUNCTION IF EXISTS public.subtract_point(UUID, TEXT);

-- Devuelve un JSONB con la misma forma que add_point:
--   { "match": <row>, "deduped": false }      -- resta aplicada
--   { "match": <row>, "deduped": true,        -- resta ignorada (duplicada)
--     "seconds_ago": <int> }
CREATE OR REPLACE FUNCTION public.subtract_point(p_match_id UUID, p_team TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  m         public.matches;
  cs        JSONB;
  cur_a     INT;
  cur_b     INT;
  new_cs    JSONB;
  v_uid     UUID := auth.uid();
  v_secs    INT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'P0001';
  END IF;
  IF p_team NOT IN ('A', 'B') THEN
    RAISE EXCEPTION 'Invalid team' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO m FROM public.matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Match not found' USING ERRCODE = 'P0002';
  END IF;

  -- Ventana antirebote: si en los últimos 10 segundos otra persona (o la
  -- misma con doble pulsación) ya restó al MISMO equipo, devolvemos el
  -- match sin cambios marcado como deduped.
  IF m.last_subtract_by = p_team
     AND m.last_subtract_at IS NOT NULL
     AND m.last_subtract_at > NOW() - INTERVAL '10 seconds'
  THEN
    v_secs := GREATEST(0, EXTRACT(EPOCH FROM (NOW() - m.last_subtract_at))::INT);
    RETURN jsonb_build_object(
      'match', to_jsonb(m),
      'deduped', TRUE,
      'seconds_ago', v_secs
    );
  END IF;

  cs := m.current_set;
  cur_a := (cs->>'a')::INT;
  cur_b := (cs->>'b')::INT;

  IF p_team = 'A' AND cur_a > 0 THEN
    cur_a := cur_a - 1;
  ELSIF p_team = 'B' AND cur_b > 0 THEN
    cur_b := cur_b - 1;
  ELSE
    -- Nada que restar (marcador a 0). Igualmente registramos la
    -- pulsación para que el dedupe se aplique a los siguientes 10s
    -- (evita que dos padres/madres "limpien" el marcador en bucle).
    UPDATE public.matches SET
      last_subtract_by   = p_team,
      last_subtract_at   = NOW(),
      last_subtract_user = v_uid
    WHERE id = p_match_id
    RETURNING * INTO m;
    RETURN jsonb_build_object('match', to_jsonb(m), 'deduped', FALSE);
  END IF;

  new_cs := jsonb_build_object('a', cur_a, 'b', cur_b, 'number', (cs->>'number')::INT);

  UPDATE public.matches SET
    current_set        = new_cs,
    serve_streak       = 0,         -- reset conservador
    last_point_at      = NULL,      -- libera el dedupe de sumar (acción opuesta)
    last_subtract_by   = p_team,
    last_subtract_at   = NOW(),
    last_subtract_user = v_uid
  WHERE id = p_match_id
  RETURNING * INTO m;

  RETURN jsonb_build_object('match', to_jsonb(m), 'deduped', FALSE);
END;
$$;

GRANT EXECUTE ON FUNCTION public.subtract_point(UUID, TEXT) TO authenticated, anon;
