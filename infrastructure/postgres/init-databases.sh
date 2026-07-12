#!/bin/sh
set -eu

psql --username "$POSTGRES_USER" --dbname postgres --set=keycloak_db="${KEYCLOAK_DB:-niet_keycloak}" <<'SQL'
SELECT format('CREATE DATABASE %I', :'keycloak_db')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'keycloak_db')\gexec
SQL
