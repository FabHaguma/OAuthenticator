# First production trial: Master's Tracker

This guide prepares `https://login.haguma.com` and gates only `https://masters.haguma.com` using the current upstream `masters-frontend:80`. Run the Docker commands on the VPS, not the Windows laptop. No live server changes were made while preparing these files.

The deployment uses `frontend_gatekeeper` (Nginx), `backend_gatekeeper` (Node/SQLite), the existing external `caddy_network`, and a separate persistent database volume. It publishes no host ports and does not alter the Master's Tracker containers.

## 1. Identify your existing Caddy installation

On the VPS:

```sh
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
```

Set the actual Caddy container name, not the image name:

```sh
CADDY_CONTAINER=your-actual-caddy-container
docker inspect "$CADDY_CONTAINER" --format '{{json .Mounts}}'
docker network inspect caddy_network
```

Find the host-side Caddyfile path in the mounts. The commands below assume its container-side path is `/etc/caddy/Caddyfile`; adjust that path if the inspect output differs. Confirm Caddy and `masters-frontend` are on `caddy_network`. Check that no existing service uses the names `frontend_gatekeeper` or `backend_gatekeeper`.

Confirm `login.haguma.com` resolves to the same server as `masters.haguma.com`. Check both A and AAAA records if IPv6 is configured.

Before editing, back up your actual host-side Caddyfile to a private backup location. Keep the existing Masters block available:

```caddyfile
masters.haguma.com {
    reverse_proxy masters-frontend:80
}
```

## 2. Transfer the current project to a new VPS folder

Use a dedicated folder, for example `~/apps/gatekeeper`. Upload the current project source including `Dockerfile`, `.dockerignore`, `compose.production.yaml`, and `deploy/`. The newly prepared files must be included; a Git pull will only contain them after you have committed and pushed them.

Exclude `.git`, local `node_modules`, `.env` credentials, local SQLite databases, and generated `frontend/dist` from transfer. The images build their own dependencies and frontend assets.

From this point, run project commands inside that VPS folder:

```sh
cd ~/apps/gatekeeper
cp deploy/.env.production.example deploy/.env.production
chmod 600 deploy/.env.production
```

## 3. Set production credentials

Edit `deploy/.env.production`. Set a new password (at least 12 characters, maximum 72 UTF-8 bytes) and a random proxy secret. Single-quote the password value if it contains `$`, `#`, or spaces so Compose preserves it literally. One simple secret generator on the VPS is:

```sh
openssl rand -hex 32
```

Copy that generated value into `PROXY_AUTH_SECRET` and keep it for the Caddy step. Do not use the example placeholder. The file also selects an identifiable image release tag. The Compose file already sets:

```text
GATEKEEPER_URL=https://login.haguma.com
COOKIE_DOMAIN=haguma.com
PROTECTED_APPS=[{"id":"masters","name":"Master's Tracker","url":"https://masters.haguma.com"}]
DATABASE_PATH=/data/gatekeeper.sqlite
```

`TRUST_PROXY=false` is safe for this initial single-user trial. The session dashboard will show the Nginx IP and failed login attempts share its per-IP budget. Do not use `TRUST_PROXY=true`. Later, configure only the actual frontend Nginx private IP and Caddy IP/ranges if you want real client IPs, and recheck them after container recreation.

The trial starts with a new persistent database; your local development database is not copied. Changing the environment password after the first startup does not change the stored password. See the main README's password-reset command; for this Compose deployment run the backend script inside the backend service with the updated environment.

## 4. Start only Gatekeeper

```sh
docker compose --env-file deploy/.env.production -f compose.production.yaml config --quiet
docker compose --env-file deploy/.env.production -f compose.production.yaml up -d --build
docker compose --env-file deploy/.env.production -f compose.production.yaml ps
```

Do not continue unless both services are healthy. Investigate a failing service with:

```sh
docker compose --env-file deploy/.env.production -f compose.production.yaml logs --tail=80 backend_gatekeeper frontend_gatekeeper
```

`config --quiet` validates without displaying expanded credentials. The health checks verify backend readiness and the Nginx process. Also test Nginx-to-backend routing:

```sh
docker compose --env-file deploy/.env.production -f compose.production.yaml exec frontend_gatekeeper wget -qO- http://127.0.0.1/health
```

Expect `{"status":"ok"}`. If an existing Caddyfile already routes login elsewhere, do not add a duplicate site block: update that block.

## 5. Publish the login host first

From [Caddyfile.masters.example](Caddyfile.masters.example), add **only** the `login.haguma.com` block to your existing mounted Caddyfile. Keep the Masters block unchanged for now.

Validate:

```sh
docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Only after validation succeeds, reload:

```sh
docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

Caddy's admin API must be enabled for reload. This uses the running container; it does not restart the Docker network, Caddy container, or unrelated applications. If Caddy cannot see the edited file, check the actual bind mount and whether an editor replaced a single-file mount; do not reset the shared stack.

Open `https://login.haguma.com` in a fresh private browser window. Confirm a valid HTTPS certificate, sign in with the new password, and check that the dashboard lists Master's Tracker. Do not protect Masters until this works.

## 6. Protect Masters

Replace the existing `masters.haguma.com` block with the complete Masters block in [Caddyfile.masters.example](Caddyfile.masters.example). Keep `masters-frontend:80` as its upstream.

Replace `PASTE_THE_PROXY_SECRET_HERE` with the same random value used for `PROXY_AUTH_SECRET`. A literal secret avoids adding an environment variable to/recreating your shared Caddy container for this trial. Keep the actual Caddyfile and backups private; never commit their real secret.

Validate and reload again using the two commands in step 5. If validation fails, do not reload.

The `route` block keeps the access check before the original upstream. Every request to this hostname, including same-origin APIs, passes through the check. Its cookie redaction preserves Master's Tracker's own cookies.

## 7. Verify the real application

Start a fresh private window so there is no existing session or cached application state:

1. Open `https://masters.haguma.com`. Expect a redirect to `https://login.haguma.com/login?...`.
2. Sign in. Expect to return to Masters and use it normally.
3. Open a real nested Masters URL and confirm sign-in returns to that exact path/query.
4. Check actual data/API requests, not just the initial HTML page.
5. Open Gatekeeper, sign out, then refresh Masters. Expect login again; a previously displayed page may remain in memory.
6. Confirm other existing sites still behave as before.
7. While signed in, test outage behavior:

```sh
docker compose --env-file deploy/.env.production -f compose.production.yaml stop backend_gatekeeper
```

Masters must return an error rather than admit a new request. Other sites should remain unaffected. Then restore it:

```sh
docker compose --env-file deploy/.env.production -f compose.production.yaml start backend_gatekeeper
```

Confirm access works again. The SQLite volume retains sessions across backend restarts. Existing long-running streams/WebSockets are not forcibly disconnected by logout.

**Check the full data boundary:** if Master's Tracker calls a separate API hostname or exposes a host port, protecting `masters.haguma.com` alone does not protect that other entry point. Protect the API hostname too (with an explicit app-origin configuration and appropriate API responses), or move its traffic behind the protected origin. Close bypass ports before treating the whole app as private.

**Shared-cookie scope:** `COOKIE_DOMAIN=haguma.com` sends the session cookie to other `haguma.com` subdomains too. This version assumes every sibling host is trusted. For the narrow trial, use a dedicated private window for login and Masters. Before broader use, redact the cookie before the upstream in every other applicable Caddy block, as shown in the template's comment. Those sites do not need a login gate. This does not isolate a malicious sibling host; unrelated/untrusted subdomains require a different session handoff design.

## 8. Roll back the Masters gate

Restore its original block:

```caddyfile
masters.haguma.com {
    reverse_proxy masters-frontend:80
}
```

Validate and reload Caddy as in step 5. Masters is public again, just as before the trial. You can leave the login service running while investigating, or remove its Caddy block and stop only the two Gatekeeper services:

```sh
docker compose --env-file deploy/.env.production -f compose.production.yaml stop
```

Keep the database volume. Do not run `down -v`, prune volumes, or restart the whole shared stack as a rollback step.

## What has been verified

The application has native tests covering authentication, proxy authorization, expiry/revocation, URL/CSRF checks, and fail-closed demo behavior. The Docker, Nginx, and Caddy files are prepared for this topology; their image builds, configuration validation, certificates, and real-network checks must run on your VPS. They have not been executed on your server by this chat.

Sources: [Caddy forward auth](https://caddyserver.com/docs/caddyfile/directives/forward_auth), [Caddy reload/validate](https://caddyserver.com/docs/command-line), [Docker external networks](https://docs.docker.com/reference/compose-file/networks/).
