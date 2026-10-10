-- What a PostgreSQL database holds, in a few lines: per table of schema public its row count and a hash of
-- its content (every row's text form hashed, the hashes sorted and hashed again), per sequence its value. Two
-- databases that print the same lines hold the same data. scripts/k8s-backup.sh runs it in the dump's own
-- snapshot and keeps the output beside the dump; scripts/k8s-restore.sh runs it on what it restored.
--   psql -X -q -t -A -v ON_ERROR_STOP=1 -d <db> -f scripts/pg-checksums.sql
-- A row's text form depends on these settings, so both sides fix them (inside the backup's transaction, too).
SET TimeZone = 'UTC';
SET DateStyle = 'ISO, YMD';
SET IntervalStyle = 'postgres';
SET extra_float_digits = 1;
SET bytea_output = 'hex';
SELECT format('SELECT %L, count(*), coalesce(md5(string_agg(h, %L ORDER BY h COLLATE "C")), %L) FROM (SELECT md5(t::text) AS h FROM public.%I t) s',
              'table ' || c.relname, '', '-', c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname COLLATE "C"
\gexec
SELECT format('SELECT %L, last_value, is_called FROM public.%I', 'sequence ' || c.relname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'S'
ORDER BY c.relname COLLATE "C"
\gexec
