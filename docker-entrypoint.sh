#!/bin/sh
set -eu

storage_dir="${ACODYSLEX_STORAGE_DIR:-/data}"
mkdir -p "$storage_dir"
chown -R app:app "$storage_dir"

# Railway injects PORT at runtime. `su` starts the final web process without
# root privileges while keeping Railway's environment variables available.
exec su -s /bin/sh app -c 'exec uvicorn app:app --host 0.0.0.0 --port "${PORT:-8000}"'
