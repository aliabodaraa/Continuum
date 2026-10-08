-- PostgreSQL for local and test stacks (docker-compose.side-by-side.yml): one server, a database and a
-- login per service, as in every environment (in Kubernetes, one CloudNativePG cluster per environment).
-- Each login can open only its own database (CONNECT is revoked from PUBLIC), so one service's
-- credentials can never read another service's data. The passwords are for throwaway local stacks only;
-- real environments take them from their secret store.
--
-- Runs once, when the database volume is created (/docker-entrypoint-initdb.d). For an existing volume:
--   docker exec -i <postgres container> psql -U continuum -d continuum < deploy/postgres/init-local.sql
-- (each statement is skipped if its role or database already exists).
SELECT 'CREATE ROLE gateway LOGIN PASSWORD ''gateway''' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway') \gexec
SELECT 'CREATE DATABASE gateway OWNER gateway' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'gateway') \gexec
SELECT 'CREATE ROLE passkey LOGIN PASSWORD ''passkey''' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'passkey') \gexec
SELECT 'CREATE DATABASE passkey OWNER passkey' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'passkey') \gexec
REVOKE CONNECT ON DATABASE gateway FROM PUBLIC;
REVOKE CONNECT ON DATABASE passkey FROM PUBLIC;
REVOKE CONNECT ON DATABASE continuum FROM PUBLIC;
