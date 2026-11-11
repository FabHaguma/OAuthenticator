const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { loadConfig } = require('./config');
const { createApp } = require('./app');

async function main() {
  const config = loadConfig();
  const { app, close } = await createApp({ config });
  const server = app.listen(config.port, config.host, () => {
    console.log(`Gatekeeper listening on ${config.host}:${config.port}; open ${config.gatewayUrl}`);
  });
  server.on('error', async (error) => {
    console.error('Unable to start Gatekeeper:', error.message);
    await close();
    process.exitCode = 1;
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close(async () => {
      await close();
    });
    server.closeIdleConnections();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Gatekeeper startup failed:', error.message);
  process.exitCode = 1;
});
