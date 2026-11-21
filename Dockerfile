FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    ACODYSLEX_STORAGE_DIR=/data

WORKDIR /app

RUN addgroup --system app && adduser --system --ingroup app app
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=app:app . ./
RUN mkdir -p /data && chown app:app /data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint
RUN chmod 755 /usr/local/bin/docker-entrypoint

EXPOSE 8000

# The entrypoint temporarily runs as root only to grant the mounted Railway
# volume to the unprivileged application user, then starts Uvicorn as `app`.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint"]
