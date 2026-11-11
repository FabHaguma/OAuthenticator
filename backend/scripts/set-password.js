const path = require('node:path');
const bcrypt = require('bcrypt');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
const { loadConfig, validatePassword } = require('../config');
const { openDatabase } = require('../db/database');

async function main() {
  const config = loadConfig();
  validatePassword(config.adminPassword);
  const hash = await bcrypt.hash(config.adminPassword, 12);
  const db = await openDatabase({ filename: config.databasePath, password: config.adminPassword });
  try {
    await db.exec('BEGIN IMMEDIATE');
    await db.run('UPDATE admin SET password_hash = ?', [hash]);
    await db.run('UPDATE gateway_sessions SET revoked_at = ? WHERE revoked_at IS NULL', [Date.now()]);
    await db.exec('COMMIT');
    console.log('Password updated. All sessions have been revoked.');
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error('Password update failed:', error.message);
  process.exitCode = 1;
});
