import 'dotenv/config';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import mysql from 'mysql2/promise';

import env from '../src/config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const schemaPath = path.join(rootDir, 'src', 'db', 'schema.sql');

function quoteIdentifier(value) {
  return `\`${String(value).replaceAll('`', '``')}\``;
}

async function migrate() {
  let serverConnection;
  let pool;

  try {
    const schemaSql = await fs.readFile(schemaPath, 'utf8');
    const statements = schemaSql
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => /^CREATE TABLE/i.test(statement));

    console.log(`Creating database if needed: ${env.DB_NAME}`);

    serverConnection = await mysql.createConnection({
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
    });

    await serverConnection.query(
      `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(env.DB_NAME)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );

    pool = mysql.createPool({
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 1,
      queueLimit: 0,
    });

    for (const statement of statements) {
      await pool.query(statement);
    }

    console.log(`Migration completed successfully. Tables checked: ${statements.length}`);
  } catch (error) {
    console.error('Migration failed.');
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (pool) {
      await pool.end();
    }

    if (serverConnection) {
      await serverConnection.end();
    }
  }
}

await migrate();
