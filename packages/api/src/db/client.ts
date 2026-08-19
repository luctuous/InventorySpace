import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import * as authSchema from './auth-schema';

export const DB_PATH = resolve(process.env.DATABASE_PATH ?? './data/inventory.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const sqlite = new Database(DB_PATH);
// SQLite does NOT enforce foreign keys by default, and WAL makes concurrent
// reads painless. Both must be set per-connection.
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
export type Db = typeof db;
