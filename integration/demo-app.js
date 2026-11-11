// Local-only example of the check Caddy performs before reaching an app.
// Run from the repository root with `npm run demo`; this is not a public proxy.
const http = require('node:http');

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function createDemoServer(options = {}) {
  const gatekeeperUrl = new URL(options.gatekeeperUrl || process.env.GATEKEEPER_URL || 'http://localhost:4000');
  const proxySecret = options.proxySecret || process.env.PROXY_AUTH_SECRET;
  const port = Number(options.port || process.env.DEMO_PORT || 3000);
  const publicUrl = new URL(`http://localhost:${port}`);

  if (!proxySecret || proxySecret.length < 32) {
    throw new Error('Set PROXY_AUTH_SECRET in backend/.env before running the demo.');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(gatekeeperUrl.hostname) || gatekeeperUrl.protocol !== 'http:') {
    throw new Error('This demo supports only a local HTTP Gatekeeper. Use Caddy for hosting.');
  }

  return http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.headers.host !== publicUrl.host || !request.url.startsWith('/') || request.url.startsWith('//')) {
      response.writeHead(421).end('Open this demo using its printed localhost URL.');
      return;
    }

    try {
      const verification = await fetch(new URL('/auth/verify', gatekeeperUrl), {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
        headers: {
          Cookie: request.headers.cookie || '',
          Accept: request.headers.accept || '*/*',
          'X-Gatekeeper-Proxy-Key': proxySecret,
          'X-Forwarded-Proto': publicUrl.protocol.slice(0, -1),
          'X-Forwarded-Host': publicUrl.host,
          'X-Forwarded-Uri': request.url,
          'X-Forwarded-Method': request.method,
          'X-Forwarded-For': request.socket.remoteAddress,
        },
      });

      if (verification.status !== 204) {
        const location = verification.headers.get('location');
        if (location) response.setHeader('Location', location);
        response.setHeader('Content-Type', verification.headers.get('content-type') || 'text/plain; charset=utf-8');
        response.writeHead(verification.status).end(await verification.text());
        return;
      }

      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('Allow', 'GET, HEAD');
        response.writeHead(405).end('This example supports only GET and HEAD.');
        return;
      }
      if (request.url === '/api/status') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ protected: true, message: 'The gateway allowed this request.' }));
        return;
      }

      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your protected app · Gatekeeper</title>
<style>body{font:16px/1.6 system-ui,sans-serif;background:#f4f6f8;color:#18252d;margin:0;padding:clamp(24px,8vw,96px)}main{max-width:620px;background:white;border:1px solid #dce3e8;border-radius:20px;padding:clamp(24px,5vw,48px);margin:auto}small{font-size:14px;color:#46635b}h1{font-size:clamp(28px,5vw,40px);line-height:1.2}a{color:#175e49}code{overflow-wrap:anywhere}nav{display:flex;gap:24px;flex-wrap:wrap}</style></head>
<body><main><small>GATEKEEPER · LOCAL DEMO</small><h1>Your app is private.</h1>
<p>The gateway checked your session before showing this page. Your existing app would be served here.</p>
<p>Requested page: <code>${escapeHtml(request.url)}</code></p>
<nav><a href="${escapeHtml(gatekeeperUrl.href)}">Manage sessions</a><a href="/">Check access again</a></nav>
<p>Log out or revoke this session in Gatekeeper, then refresh this page to see access blocked.</p>
</main></body></html>`);
    } catch {
      // An unavailable gateway never grants access.
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.writeHead(503).end('Gatekeeper is unavailable. Access remains blocked.');
    }
  });
}

if (require.main === module) {
  try {
    const port = Number(process.env.DEMO_PORT || 3000);
    const server = createDemoServer({ port });
    server.listen(port, '127.0.0.1', () => {
      console.log(`Protected demo: http://localhost:${port}`);
      console.log('Keep this localhost-only example off the public internet.');
    });
    server.on('error', error => {
      console.error(`Demo startup failed: ${error.message}`);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { createDemoServer };
