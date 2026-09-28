-- Database and role bootstrap (plan section 10; ADR-002 section 5).
--
-- Run once per PostgreSQL server as a superuser, before any migration:
--   local:  automatically by docker-compose (sql/docker-init.sh)
--   CI:     psql -v app_db=... -v owner_password=... -v app_password=... -f bootstrap-roles.sql
-- Idempotent: safe to re-run.
--
-- Roles:
--   tali_owner  owns the databases and schemas and runs migrations.
--               Never used by the running API or worker.
--   tali_app    runtime role for the API and worker. No DDL, no ownership,
--               no role or database creation, no RLS bypass. Table privileges
--               are granted explicitly by each migration; there are no
--               default privileges, so new tables are inaccessible until a
--               migration grants access.
--
-- Passwords are supplied by the caller. The local/CI values are synthetic and
-- must never be used for a shared or deployed environment.

\set ON_ERROR_STOP on

SELECT format('CREATE ROLE tali_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'owner_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tali_owner')
\gexec

SELECT format('CREATE ROLE tali_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tali_app')
\gexec

-- Application database and the Prisma shadow database used by `migrate dev`
-- and the drift check. Both are owned by tali_owner.
SELECT format('CREATE DATABASE %I OWNER tali_owner', :'app_db')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'app_db')
\gexec

SELECT format('CREATE DATABASE %I OWNER tali_owner', :'app_db' || '_shadow')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'app_db' || '_shadow')
\gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'app_db') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO tali_app', :'app_db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'app_db' || '_shadow') \gexec

\connect :"app_db"

ALTER SCHEMA public OWNER TO tali_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO tali_app;
