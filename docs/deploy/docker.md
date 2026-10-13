# Deploy with Docker Compose

Deploy the frontend and backend with a persistent SQLite database. Complete the [quick start](/guide/quick-start) first.

## Select an image version

Set the image tag in the root `.env`:

```dotenv
EXCALIDASH_TAG=latest
```

Pull and start both images:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Pin a release for repeatable deployments. Use the same version for both images.

## Configure HTTPS

Route HTTPS traffic to container port `80` or `8080`, or host port `6767`. Both container ports serve the same application. Existing `6767:80` mappings and reverse proxies targeting port `80` remain supported. The frontend proxies API and real-time traffic to the backend.

Create `compose.override.yml` with your public origin and the number of trusted proxy hops:

```yaml
services:
  backend:
    environment:
      FRONTEND_URL: https://excalidash.alpacawebservices.com
      TRUST_PROXY: "1"
```

Replace `https://excalidash.alpacawebservices.com` with your URL. The hop count must match your proxy chain and your proxies must replace untrusted forwarding headers and forward WebSocket upgrades for `/socket.io/`.

Apply the override:

```bash
docker compose -f docker-compose.prod.yml -f compose.override.yml up -d
```

## Host proxy deployment

The fork forwards `FRONTEND_URL`, `TRUST_PROXY`, and OIDC settings from the root environment into the backend.
The backend publishes port `8000` on loopback for a host reverse proxy.
Route frontend traffic to `127.0.0.1:6767`, `/api/` to `127.0.0.1:8000/`, and `/socket.io/` to `127.0.0.1:8000/socket.io/`.
Strip the `/api` prefix when forwarding to the backend.
Forward WebSocket upgrades and the public HTTPS scheme.
Set `TRUST_PROXY=1` when the host proxy is the single trusted hop.

The frontend image also retains upstream API and WebSocket proxy support.
Count both proxy hops if the host proxy sends API requests through the frontend container.

Set `OIDC_ALLOWED_EMAILS` to a comma-separated list to restrict OIDC sign-in.
The backend trims entries and compares email addresses without regard to case.
An empty list permits any email accepted by the other OIDC checks.
An unlisted email is rejected before identity lookup or provisioning.

## Non-root port binding

The frontend runs as the non-root nginx user. Modern Docker permits it to bind port `80` inside its network namespace. On Docker installations that restrict low ports, add this frontend override to allow the listener without running nginx as root:

```yaml
services:
  frontend:
    sysctls:
      net.ipv4.ip_unprivileged_port_start: "0"
```

This setting applies to the container network namespace, not the host.

## Persist and back up data

The `backend-data` volume holds SQLite data, image records, and generated signing secrets. Scheduled backups copy the SQLite database. Please save your signing secrets separately.

Add these entries to `compose.override.yml` to enable daily database backups at 04:00 in the container's timezone:

```yaml
services:
  backend:
    environment:
      BACKUP_SCHEDULE: "0 0 4 * * *"
      BACKUP_DIR: /app/backups
      BACKUP_RETENTION_DAYS: "14"
    volumes:
      - backup-data:/app/backups
volumes:
  backup-data:
```

Initialize the backup volume for the backend's user (UID 1001), then apply the override:

```bash
docker compose -f docker-compose.prod.yml -f compose.override.yml run --rm --no-deps --user 0 --entrypoint sh backend -c 'chown 1001:1001 /app/backups'
docker compose -f docker-compose.prod.yml -f compose.override.yml up -d
```

Check the backend logs for backup errors and test restoring a backup. For PostgreSQL, use your database's backup tools. If you use S3, back up its objects too.

## Upgrade

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```
