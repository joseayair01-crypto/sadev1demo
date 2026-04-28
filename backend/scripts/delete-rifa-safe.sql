-- Borrado total y seguro de UNA rifa desde Supabase SQL Editor.
-- Uso:
-- 1) Cambia v_rifa_id y v_expected_slug.
-- 2) Ejecuta primero la seccion "preflight".
-- 3) Si todo coincide, ejecuta la seccion "delete".
--
-- Protecciones:
-- - Falla si la rifa no existe.
-- - Falla si el slug no coincide.
-- - Falla si la rifa es publica activa.
-- - Falla si la rifa es la predeterminada.
-- - Falla si el estado no parece eliminable.

-- =========================
-- PREFLIGHT
-- =========================
WITH target AS (
  SELECT id, slug, nombre, estado, activa_publica, es_predeterminada, finalizada_at, depurada_at
  FROM rifas
  WHERE id = 0
)
SELECT
  t.*,
  (SELECT COUNT(*) FROM ganadores g WHERE g.rifa_id = t.id) AS total_ganadores,
  (SELECT COUNT(*) FROM orden_oportunidades oo WHERE oo.rifa_id = t.id) AS total_oportunidades,
  (SELECT COUNT(*) FROM boletos_estado be WHERE be.rifa_id = t.id) AS total_boletos_estado,
  (SELECT COUNT(*) FROM ordenes o WHERE o.rifa_id = t.id) AS total_ordenes
FROM target t;

-- URLs externas asociadas a ordenes de la rifa.
-- OJO: esto solo lista referencias. Borrar la BD NO elimina archivos en Cloudinary.
SELECT numero_orden, comprobante_path
FROM ordenes
WHERE rifa_id = 0
  AND comprobante_path IS NOT NULL
ORDER BY numero_orden;

-- =========================
-- DELETE
-- =========================
BEGIN;

DO $$
DECLARE
  v_rifa_id integer := 0;
  v_expected_slug text := '';
  v_nombre text;
  v_slug text;
  v_estado text;
  v_activa_publica boolean;
  v_es_predeterminada boolean;
  v_rows integer;
BEGIN
  SELECT nombre, slug, estado, activa_publica, es_predeterminada
  INTO v_nombre, v_slug, v_estado, v_activa_publica, v_es_predeterminada
  FROM rifas
  WHERE id = v_rifa_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe la rifa con id=%', v_rifa_id;
  END IF;

  IF COALESCE(NULLIF(TRIM(v_expected_slug), ''), '__missing__') <> v_slug THEN
    RAISE EXCEPTION 'Slug de seguridad no coincide. Esperado="%", real="%"', v_expected_slug, v_slug;
  END IF;

  IF v_activa_publica THEN
    RAISE EXCEPTION 'Bloqueado: la rifa % (%) es la publica activa', v_rifa_id, v_slug;
  END IF;

  IF v_es_predeterminada THEN
    RAISE EXCEPTION 'Bloqueado: la rifa % (%) es la predeterminada', v_rifa_id, v_slug;
  END IF;

  IF LOWER(COALESCE(TRIM(v_estado), '')) NOT IN ('finalizado', 'archivada', 'depurada') THEN
    RAISE EXCEPTION 'Bloqueado: estado no eliminable ("%"). Solo se permite finalizado, archivada o depurada', v_estado;
  END IF;

  DELETE FROM ganadores WHERE rifa_id = v_rifa_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'ganadores eliminados: %', v_rows;

  DELETE FROM orden_oportunidades WHERE rifa_id = v_rifa_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'orden_oportunidades eliminadas: %', v_rows;

  DELETE FROM boletos_estado WHERE rifa_id = v_rifa_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'boletos_estado eliminados: %', v_rows;

  DELETE FROM ordenes WHERE rifa_id = v_rifa_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'ordenes eliminadas: %', v_rows;

  DELETE FROM rifas WHERE id = v_rifa_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'No se elimino exactamente 1 fila en rifas. Resultado=%', v_rows;
  END IF;

  IF EXISTS (SELECT 1 FROM ganadores WHERE rifa_id = v_rifa_id) THEN
    RAISE EXCEPTION 'Persisten filas en ganadores para rifa_id=%', v_rifa_id;
  END IF;

  IF EXISTS (SELECT 1 FROM orden_oportunidades WHERE rifa_id = v_rifa_id) THEN
    RAISE EXCEPTION 'Persisten filas en orden_oportunidades para rifa_id=%', v_rifa_id;
  END IF;

  IF EXISTS (SELECT 1 FROM boletos_estado WHERE rifa_id = v_rifa_id) THEN
    RAISE EXCEPTION 'Persisten filas en boletos_estado para rifa_id=%', v_rifa_id;
  END IF;

  IF EXISTS (SELECT 1 FROM ordenes WHERE rifa_id = v_rifa_id) THEN
    RAISE EXCEPTION 'Persisten filas en ordenes para rifa_id=%', v_rifa_id;
  END IF;

  IF EXISTS (SELECT 1 FROM rifas WHERE id = v_rifa_id) THEN
    RAISE EXCEPTION 'Persistio la fila principal en rifas para id=%', v_rifa_id;
  END IF;

  RAISE NOTICE 'Rifa eliminada por completo: id=%, slug=%, nombre=%', v_rifa_id, v_slug, v_nombre;
END $$;

COMMIT;

-- Verificacion final
SELECT
  (SELECT COUNT(*) FROM rifas WHERE id = 0) AS rifas_restantes,
  (SELECT COUNT(*) FROM ganadores WHERE rifa_id = 0) AS ganadores_restantes,
  (SELECT COUNT(*) FROM orden_oportunidades WHERE rifa_id = 0) AS oportunidades_restantes,
  (SELECT COUNT(*) FROM boletos_estado WHERE rifa_id = 0) AS boletos_restantes,
  (SELECT COUNT(*) FROM ordenes WHERE rifa_id = 0) AS ordenes_restantes;
