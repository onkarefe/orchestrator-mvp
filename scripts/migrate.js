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
const migrationsDir = path.join(rootDir, 'src', 'db', 'migrations');

function quoteIdentifier(value) {
  return `\`${String(value).replaceAll('`', '``')}\``;
}

function hasExecutableSql(statement) {
  return statement.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();

    return trimmed && !trimmed.startsWith('--') && !trimmed.startsWith('#');
  });
}

function splitSqlStatements(sql) {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(hasExecutableSql);
}

async function readMigrationFiles() {
  try {
    const fileNames = await fs.readdir(migrationsDir);

    return fileNames
      .filter((fileName) => fileName.endsWith('.sql'))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function ensureSchemaMigrationsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_schema_migrations_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function getAppliedMigrationNames(pool) {
  const [rows] = await pool.query('SELECT name FROM schema_migrations');

  return new Set(rows.map((row) => row.name));
}

async function applyMigrationFile(pool, fileName) {
  const migrationPath = path.join(migrationsDir, fileName);
  const migrationSql = await fs.readFile(migrationPath, 'utf8');
  const statements = splitSqlStatements(migrationSql);

  for (const statement of statements) {
    await pool.query(statement);
  }

  await pool.execute('INSERT INTO schema_migrations (name) VALUES (?)', [
    fileName,
  ]);
}

async function migrate() {
  let serverConnection;
  let pool;

  try {
    const schemaSql = await fs.readFile(schemaPath, 'utf8');
    const schemaStatements = splitSqlStatements(schemaSql).filter((statement) =>
      /^CREATE TABLE/i.test(statement)
    );

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

    await ensureSchemaMigrationsTable(pool);

    for (const statement of schemaStatements) {
      await pool.query(statement);
    }

    const migrationFiles = await readMigrationFiles();
    const appliedMigrationNames = await getAppliedMigrationNames(pool);
    let appliedMigrationCount = 0;

    for (const fileName of migrationFiles) {
      if (appliedMigrationNames.has(fileName)) {
        continue;
      }

      await applyMigrationFile(pool, fileName);
      appliedMigrationCount += 1;
      console.log(`Applied migration: ${fileName}`);
    }

    console.log(
      `Migration completed successfully. Tables checked: ${schemaStatements.length}. Migrations applied: ${appliedMigrationCount}`
    );
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
