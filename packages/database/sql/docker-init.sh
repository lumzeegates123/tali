#!/bin/sh
# Invoked by the official postgres image on first start (docker-entrypoint-initdb.d).
set -eu

psql --no-psqlrc --username "$POSTGRES_USER" --dbname postgres \
  -v app_db="$TALI_DATABASE" \
  -v owner_password="$TALI_OWNER_PASSWORD" \
  -v app_password="$TALI_APP_PASSWORD" \
  -f /tali/bootstrap-roles.sql
