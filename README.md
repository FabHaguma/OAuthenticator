# Gatekeeper

One private login for your personal web apps. Gatekeeper runs alongside your existing applications and tells Caddy whether to let each browser request through. Your apps usually need no authentication code changes.

Open an app, sign in at Gatekeeper, and return to the page you requested. The same browser session can unlock your other trusted apps under the same parent domain.

This project is a **single-user authentication gateway**. It does not provide an OAuth/OIDC server, Google/GitHub sign-in, public registration, or per-app user accounts.

```text
Browser -> Caddy -> your existing app
              |
              +-> Gatekeeper checks the login session
```

## What is included

- One password-protected account with a central login page.
- Persistent SQLite sessions, expiry, logout, device/session revocation, and revoke-other-sessions.
- An app launcher and a session dashboard.
- A Caddy `forward_auth` endpoint with a server-only proxy secret.
- Server-set HttpOnly cookies; Secure cookies when using HTTPS.
- Login throttling, same-origin mutation checks, CSRF protection, and allowlisted return destinations.
- A native local demo and a Caddy integration template.

The backend is Node.js/Express with SQLite and bcrypt. The frontend retains the existing React/Vite stack and is served by the backend after building. Authentication no longer uses approval requests, WebSockets, JWTs, or browser local-storage tokens.

## Run locally

Use Node.js **22.12 or later** and npm. Docker and Caddy are not needed for the local demo.

From the repository root:

```powershell
npm run install:all
Copy-Item backend/.env.example backend/.env
```

Edit `backend/.env`. Set a strong `ADMIN_PASSWORD` and a random `PROXY_AUTH_SECRET`; keep the supplied localhost URLs for the demo. Generate the proxy secret with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Build the frontend and start Gatekeeper:

```sh
npm run build
npm start
```

Open [http://localhost:4000](http://localhost:4000) and sign in with the password you configured. Both the UI and API run on this origin.

In a second terminal, from the repository root:

```sh
npm run demo
```

Open [http://localhost:3000](http://localhost:3000). This loopback-only example mimics Caddy's access check before displaying a small protected page. It reads the same `backend/.env`. Use **localhost** consistently in the browser: cookies for `localhost` and `127.0.0.1` are different.

Try a private browser window to see the login redirect. After signing in, log out or revoke that session from the dashboard, then refresh the demo. It should redirect to login again. Stop Gatekeeper and refresh the demo: access should remain blocked with a service-unavailable message.

## Configuration

Configuration lives in ignored `backend/.env`; see [backend/.env.example](backend/.env.example). Never put the proxy secret or password in frontend files.

| Setting | Purpose |
| --- | --- |
| `HOST` | Backend bind address; defaults to `127.0.0.1`. |
| `PORT` | Backend port; defaults to `4000`. |
| `GATEKEEPER_URL` | Exact browser-facing login origin, such as `http://localhost:4000` or `https://login.example.com`. No subpath. |
| `ADMIN_PASSWORD` | Seeds the initial password hash only. Use at least 12 characters and at most 72 UTF-8 bytes. |
| `GATEKEEPER_USERNAME` | Display name for the single account; defaults to `owner`. |
| `PROXY_AUTH_SECRET` | Random server-only secret, at least 32 characters, shared with Caddy. |
| `PROTECTED_APPS` | JSON array of allowed apps with unique `id`, `name`, and exact `url` origin. |
| `COOKIE_DOMAIN` | Blank for localhost; shared parent domain such as `example.com` for trusted production subdomains. |
| `SESSION_TTL_HOURS` | Fixed session lifetime; defaults to `168` hours. |
| `DATABASE_PATH` | SQLite file; relative paths resolve from `backend/`. Defaults to `backend/database.sqlite`. |
| `TRUST_PROXY` | Trusted proxy IPs/ranges. Defaults to loopback; restrict production to Caddy's real private address/range. |
| `NODE_ENV` | Set `production` for hosting. Production requires HTTPS for the login and protected apps. |
| `DEV_UI_ORIGIN` | Optional Vite UI origin for development, such as `http://127.0.0.1:5173`; not for production. |
| `LOGIN_MAX_ATTEMPTS` | Per-IP sign-in attempt budget in a 15-minute window; defaults to `5`. |
| `LOGIN_GLOBAL_MAX_ATTEMPTS` | Global sign-in attempt budget in that window; defaults to `30`. |

Example local app list:

```dotenv
PROTECTED_APPS='[{"id":"demo","name":"Protected demo","url":"http://localhost:3000"}]'
```

Example production origins:

```dotenv
NODE_ENV=production
GATEKEEPER_URL=https://login.example.com
COOKIE_DOMAIN=example.com
PROTECTED_APPS='[{"id":"notes","name":"Notes","url":"https://notes.example.com"},{"id":"expenses","name":"Expenses","url":"https://expenses.example.com"}]'
```

Use origins rather than paths: `https://notes.example.com`, not `https://notes.example.com/private`. Configure which paths are protected in Caddy. Restart Gatekeeper after configuration changes.

### Update protected apps on the VPS

1. Edit `backend/.env` in your VPS checkout. Keep exactly one `PROTECTED_APPS` line containing the complete JSON array of apps; use the generic format above with your own HTTPS origins.
2. From that checkout, validate and apply the configuration:

```sh
docker compose --env-file backend/.env -f compose.production.yaml config --quiet
docker compose --env-file backend/.env -f compose.production.yaml up -d backend_gatekeeper
```

Run the second command only after validation succeeds. Compose passes `PROTECTED_APPS` from the environment file into the backend; no image rebuild is needed for app-list changes. An existing app's Caddy route stays as it is. Add a Caddy `forward_auth` gate for each newly protected hostname, then validate and reload Caddy as described below.

The real app list belongs only in ignored `backend/.env` on each machine. Keep generic placeholders in committed examples. The environment file is also excluded from Docker build contexts; Compose supplies its selected values at runtime. Commit and push the Compose wiring and documentation, and edit the VPS environment file directly.

The first version deliberately supports trusted apps under one parent domain. A shared parent-domain cookie means every host under that domain must be trusted; a compromised or untrusted sibling host can undermine this boundary. The Caddy example redacts the gateway cookie before forwarding to your apps, but does not make untrusted sibling domains safe. Unrelated domains require a separate login handoff design.

### Change your password

Editing `ADMIN_PASSWORD` alone does not replace an existing database password hash. To change or recover the password, update it in `backend/.env`, stop the backend, then run:

```sh
npm run password:set
npm start
```

The command updates the password hash and revokes existing gateway sessions. Keep `.env` private; it contains a usable password as well as the proxy secret.

## Attach an existing app with Caddy

For the first VPS trial at `login.haguma.com` protecting Master's Tracker, follow the [production trial guide](deploy/masters-test.md). It uses the included production Dockerfile, Compose file, Nginx configuration, and domain-specific Caddy blocks. No server changes have been applied automatically.

[integration/Caddyfile.example](integration/Caddyfile.example) shows the login host and one protected app. It is a template to merge into your existing configuration; nothing is deployed automatically.

1. Give Gatekeeper and your apps HTTPS subdomains under your trusted parent domain.
2. Configure `GATEKEEPER_URL`, `COOKIE_DOMAIN`, and each exact app origin in `PROTECTED_APPS`.
3. Give Caddy an environment variable named `GATEKEEPER_PROXY_SECRET` containing the same value as Gatekeeper's `PROXY_AUTH_SECRET`.
4. Add the template's `forward_auth` check before forwarding each protected app to its existing upstream.
5. Include the template's cookie redaction and proxy-secret header removal for every app upstream.
6. Keep app listening ports and the Gatekeeper upstream private. Only Caddy's HTTPS entry points should be publicly reachable.

Caddy asks Gatekeeper to verify the session before serving the app. A successful check returns `204`; an unauthenticated browser navigation redirects to the login page. An unauthenticated API request or unsafe method receives `401` rather than a login page. Unknown app origins and incorrect proxy secrets are rejected. An unavailable gateway blocks access.

The template explicitly overwrites forwarded URL/method headers and supplies the secret only on Caddy's internal verification request. It also blocks the verification path on the public login hostname. If Caddy runs in a container, replace loopback upstreams with the correct private service addresses and trust only the relevant Caddy IP/range. Preserve your existing ingress/network arrangement.

Validate the adapted configuration with `caddy validate --config <your-config> --adapter caddyfile` on the host where Caddy is installed. Then test signed-out access, sign-in and return to the original path, logout/revocation, gateway failure, forged forwarding headers, and attempted direct-port access. The included native demo does not validate a production Caddy/network setup.

See the official [Caddy forward-auth documentation](https://caddyserver.com/docs/caddyfile/directives/forward_auth) and [upstream header controls](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers).

## API

Browser APIs use the `gatekeeper_session` cookie. Mutating requests require the exact configured UI `Origin`, `X-Gatekeeper-Request: 1`, and JSON content type. Authenticated mutations also require `X-CSRF-Token` from the current session response.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Backend readiness. |
| `GET` | `/api/v1/session` | Authentication state; includes CSRF token when signed in. |
| `POST` | `/api/v1/login` | Authenticate with `{ "password": "…", "returnTo": "…" }` and set the session cookie. |
| `POST` | `/api/v1/logout` | Revoke the current session and clear its cookie. |
| `GET` | `/api/v1/apps` | List configured protected apps. |
| `GET` | `/api/v1/sessions` | List current unexpired sessions and identify this browser. |
| `POST` | `/api/v1/sessions/revoke-others` | Revoke every other session. |
| `POST` | `/api/v1/sessions/:id/revoke` | Revoke a particular session. |
| `GET` | `/auth/verify` | Private Caddy check; requires `X-Gatekeeper-Proxy-Key` and original-request forwarding metadata. |

Legacy `/admin/*`, `/auth/request`, and JWT verification clients are retired. The old integration middleware has been removed; app code should rely on the gateway at the proxy boundary instead.

## Development and tests

| Root command | Purpose |
| --- | --- |
| `npm run install:all` | Install the locked backend and frontend dependencies. |
| `npm run build` | Build the frontend into `frontend/dist/`. |
| `npm start` | Start the backend and built frontend. |
| `npm run dev` | Start the backend with Node's watch mode; build the frontend first. |
| `npm run demo` | Start the protected localhost demo using `backend/.env`. |
| `npm test` | Run backend security and protected-demo tests using disposable databases. |
| `npm run lint` | Lint the frontend. |
| `npm run password:set` | Update the password and revoke all sessions. |

For frontend hot reload, set `DEV_UI_ORIGIN=http://127.0.0.1:5173`, restart the backend, and run `npm run dev` from `frontend/` in a separate terminal. Open that exact Vite origin. Vite proxies API requests to the local backend; cookies on `127.0.0.1` do not carry over to the `localhost` demo. The ordinary built frontend at port 4000 provides the simplest end-to-end login demo.

## Persistence and scope

Back up `backend/database.sqlite` while the backend is stopped, or use a SQLite-aware backup. Preserve the database across restarts and releases. Database files, secrets, and generated builds are excluded from source control. Sessions store token hashes rather than raw browser credentials.

Existing databases keep their administrator password hash and legacy tables. The new gateway adds its own session storage; legacy application approvals and JWTs do not grant access. Back up an existing database before the first upgraded startup.

Session revocation blocks the next checked request. It does not erase an already displayed page or automatically disconnect an established WebSocket/stream. Apps with webhooks, native clients, or scripts need an explicit authentication design for those callers. The gateway also does not replace an app's own user permissions.

## License

See [LICENSE](LICENSE) for the Apache License 2.0.
