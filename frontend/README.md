# Gatekeeper frontend

The single-user login page and session dashboard, built with React, Vite, and plain CSS. See the [project README](../README.md) for backend configuration and Caddy integration.

## Normal local use

```sh
npm ci
npm run build
```

The backend serves `frontend/dist/` on its own origin. This is the simplest way to use the entire app locally: build the frontend, start the backend, and open its URL.

## Frontend development

Run the backend on port 4000 with `DEV_UI_ORIGIN=http://127.0.0.1:5173`, then run:

```sh
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` requests to the backend. Use this exact origin to satisfy the backend's Origin checks. `DEV_UI_ORIGIN` is for local development only and must not be enabled in production.

All API URLs are relative. The browser uses an HttpOnly session cookie; no authentication token is stored in local storage. Successful login destinations are validated by the backend. Authenticated actions send a CSRF token obtained from `/api/v1/session`.

## Commands

- `npm run dev`: local Vite development server.
- `npm run build`: write the production frontend to `dist/`.
- `npm run lint`: check JavaScript and React code.
- `npm run preview`: inspect a frontend build; it does not provide the backend API by itself.

## Files

- `src/App.jsx`: session bootstrap and page routing.
- `src/api.js`: same-origin API requests and errors.
- `src/pages/Login.jsx`: password sign-in.
- `src/pages/Dashboard.jsx`: application links and device sessions.
- `src/index.css` and `src/App.css`: shared styles and responsive layouts.

Tailwind and the former approval dashboard are no longer used.
