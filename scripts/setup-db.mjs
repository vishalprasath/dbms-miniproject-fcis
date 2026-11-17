// One-command setup for both databases.
//
//   npm run db:setup     -> PostgreSQL (schema, routines, triggers, views, roles, seed) + MongoDB
//   npm run db:mongo     -> MongoDB only (collections, validators, indexes, seed documents)
//
// All connection details come from .env.local (see .env.example).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { MongoClient } from 'mongodb';
import { setupMongo } from '../db/mongo/setup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mongoOnly = process.argv.includes('--mongo-only');

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Copy .env.example to .env.local and fill it in.`);
    process.exit(1);
  }
  return v;
}

const adminUrl = need('PG_ADMIN_URL');
const dbName = process.env.PG_DATABASE || 'fcis';
const appUrl = new URL(need('DATABASE_URL'));
const mongoUri = need('MONGODB_URI');
const mongoDbName = process.env.MONGODB_DB || 'fcis';

if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) {
  console.error('PG_DATABASE must be a simple lowercase identifier.');
  process.exit(1);
}

const SQL_FILES = [
  '01_schema.sql',
  '02_functions_procedures.sql',
  '03_triggers.sql',
  '04_views.sql',
  '05_roles.sql',
  '06_seed.sql',
];

async function setupPostgres() {
  // 1. create the database if it is not there yet
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE ${dbName}`);
    console.log(`  created database ${dbName}`);
  }
  await admin.end();

  // 2. run the SQL files, in order, as the owner
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${dbName}`;
  const owner = new pg.Client({ connectionString: ownerUrl.toString() });
  await owner.connect();
  try {
    for (const file of SQL_FILES) {
      const sql = await fs.readFile(path.join(root, 'db', 'sql', file), 'utf8');
      try {
        await owner.query(sql);
      } catch (err) {
        const where = err.position ? ` (near: ${sql.slice(Math.max(0, err.position - 80), +err.position + 80).replace(/\s+/g, ' ')})` : '';
        throw new Error(`${file}: ${err.message}${err.where ? `\n  ${err.where}` : ''}${where}`);
      }
      console.log(`  ran ${file}`);
    }

    // 3. give the login role the password from DATABASE_URL (never stored in SQL files)
    const appRole = decodeURIComponent(appUrl.username);
    const appPassword = decodeURIComponent(appUrl.password);
    if (appRole !== 'fcis_app') throw new Error('DATABASE_URL must connect as the fcis_app role.');
    if (!appPassword) throw new Error('DATABASE_URL must contain a password for fcis_app.');
    await owner.query(`ALTER ROLE fcis_app PASSWORD ${pg.escapeLiteral(appPassword)}`);
    await owner.query(`GRANT CONNECT ON DATABASE ${dbName} TO fcis_app`);
    console.log('  set password for login role fcis_app');

    const counts = await owner.query(`
      SELECT (SELECT COUNT(*) FROM fcis.commitments)         AS commitments,
             (SELECT COUNT(*) FROM fcis.commitment_schedule) AS instalments,
             (SELECT COUNT(*) FROM fcis.transactions)        AS transactions,
             (SELECT COUNT(*) FROM fcis.shortfall_alerts)    AS alerts`);
    console.log('  seeded:', counts.rows[0]);
  } finally {
    await owner.end();
  }
}

async function main() {
  if (!mongoOnly) {
    console.log('PostgreSQL');
    await setupPostgres();
  }

  console.log('MongoDB');
  const pgApp = new pg.Client({ connectionString: (() => { const u = new URL(adminUrl); u.pathname = `/${dbName}`; return u.toString(); })() });
  await pgApp.connect();
  const mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
  try {
    await mongo.connect();
    await setupMongo({ db: mongo.db(mongoDbName), pg: pgApp, log: (m) => console.log(`  ${m}`) });
  } finally {
    await mongo.close();
    await pgApp.end();
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});
