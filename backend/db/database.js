const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');
const fs = require('node:fs/promises');
const path = require('node:path');

async function openDatabase({ filename, password }) {
  if (filename !== ':memory:') await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const connection = await new Promise((resolve, reject) => {
    const handle = new sqlite3.Database(filename, (error) => error ? reject(error) : resolve(handle));
  });
  const db = {
    run(sql, params = []) {
      return new Promise((resolve, reject) => connection.run(sql, params, function (error) {
        if (error) reject(error); else resolve({ changes: this.changes, lastID: this.lastID });
      }));
    },
    get(sql, params = []) {
      return new Promise((resolve, reject) => connection.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
    },
    all(sql, params = []) {
      return new Promise((resolve, reject) => connection.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
    },
    exec(sql) { return new Promise((resolve, reject) => connection.exec(sql, (error) => error ? reject(error) : resolve())); },
    close() { return new Promise((resolve, reject) => connection.close((error) => error ? reject(error) : resolve())); },
  };
  try {
    await db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const { user_version: version } = await db.get('PRAGMA user_version');
    if (version > 1) throw new Error('Database schema is newer than this version of Gatekeeper.');
    if (version < 1) {
      const migration = await fs.readFile(path.join(__dirname, 'migrations/001-gateway.sql'), 'utf8');
      await db.exec(migration);
    }
    const admin = await db.get('SELECT id FROM admin ORDER BY id LIMIT 1');
    if (!admin) {
      if (!password) throw new Error('No account exists. Set ADMIN_PASSWORD in backend/.env before the first start.');
      const hash = await bcrypt.hash(password, 12);
      await db.run('INSERT INTO admin (password_hash) VALUES (?)', [hash]);
    }
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

module.exports = { openDatabase };
