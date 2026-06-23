import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, resolveDbPath } from '../db.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fs from 'fs';

describe('SQLite WAL Mode', () => {
  const testDbPath = path.resolve(process.cwd(), 'test_ann_ledger.sqlite');

  beforeEach(() => {
    // Clean up test db if exists
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    if (fs.existsSync(testDbPath + '-shm')) {
      fs.unlinkSync(testDbPath + '-shm');
    }
    if (fs.existsSync(testDbPath + '-wal')) {
      fs.unlinkSync(testDbPath + '-wal');
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    if (fs.existsSync(testDbPath + '-shm')) {
      fs.unlinkSync(testDbPath + '-shm');
    }
    if (fs.existsSync(testDbPath + '-wal')) {
      fs.unlinkSync(testDbPath + '-wal');
    }
  });

  it('should enable WAL mode and have busy timeout', async () => {
    const db = await open({
      filename: testDbPath,
      driver: sqlite3.Database
    });

    await db.exec('PRAGMA journal_mode = WAL;');
    await db.exec('PRAGMA busy_timeout = 5000;');

    const journalMode = await db.get('PRAGMA journal_mode;');
    expect(journalMode.journal_mode).toBe('wal');

    const busyTimeout = await db.get('PRAGMA busy_timeout;');
    expect(busyTimeout).toBeDefined();
    expect(Number(busyTimeout.busy_timeout || busyTimeout.timeout)).toBe(5000);

    await db.close();
  });
});

describe('ANN DB path resolution', () => {
  const originalDbPath = process.env.ANN_DB_PATH;
  const originalIdentityDir = process.env.ANN_IDENTITY_DIR;

  afterEach(() => {
    if (originalDbPath === undefined) {
      delete process.env.ANN_DB_PATH;
    } else {
      process.env.ANN_DB_PATH = originalDbPath;
    }
    if (originalIdentityDir === undefined) {
      delete process.env.ANN_IDENTITY_DIR;
    } else {
      process.env.ANN_IDENTITY_DIR = originalIdentityDir;
    }
  });

  it('uses ANN_DB_PATH when configured', () => {
    process.env.ANN_DB_PATH = '/tmp/ann-custom.sqlite';
    expect(resolveDbPath()).toBe('/tmp/ann-custom.sqlite');
  });

  it('falls back to ANN_IDENTITY_DIR local ledger', () => {
    delete process.env.ANN_DB_PATH;
    process.env.ANN_IDENTITY_DIR = '/tmp/ann-id';
    expect(resolveDbPath()).toBe('/tmp/ann-id/local_ann_ledger.sqlite');
  });
});
