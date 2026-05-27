import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import fs from 'fs';

describe('SQLite Concurrent Write Performance', () => {
  const testDbPath = path.resolve(process.cwd(), 'perf_test_ann_ledger.sqlite');
  let db: Database | null = null;

  beforeEach(async () => {
    // Clean up any existing test db files
    [testDbPath, testDbPath + '-shm', testDbPath + '-wal'].forEach((f) => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });

    db = await open({
      filename: testDbPath,
      driver: sqlite3.Database,
    });

    await db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS perf_test_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cid TEXT NOT NULL,
        title TEXT NOT NULL,
        author_pubkey TEXT NOT NULL,
        signature TEXT NOT NULL,
        vector_json TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_perf_cid ON perf_test_records(cid);
      CREATE INDEX IF NOT EXISTS idx_perf_expires ON perf_test_records(expires_at);
    `);
  });

  afterEach(async () => {
    if (db) {
      await db.close();
      db = null;
    }
    [testDbPath, testDbPath + '-shm', testDbPath + '-wal'].forEach((f) => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
  });

  it('should handle 100 concurrent connections writing with high throughput', async () => {
    const CONCURRENT_CONNECTIONS = 100;
    const RECORDS_PER_CONNECTION = 10;
    const TOTAL_RECORDS = CONCURRENT_CONNECTIONS * RECORDS_PER_CONNECTION;

    // Create multiple database connections
    const connections: Database[] = [];
    for (let i = 0; i < CONCURRENT_CONNECTIONS; i++) {
      const conn = await open({
        filename: testDbPath,
        driver: sqlite3.Database,
      });
      await conn.exec('PRAGMA journal_mode = WAL;');
      await conn.exec('PRAGMA busy_timeout = 5000;');
      connections.push(conn);
    }

    const startTime = performance.now();
    const lockErrors: Error[] = [];

    // Launch all writes concurrently
    const writePromises = connections.map(async (conn, connIdx) => {
      for (let j = 0; j < RECORDS_PER_CONNECTION; j++) {
        const recordId = connIdx * RECORDS_PER_CONNECTION + j;
        try {
          await conn.run(
            `INSERT INTO perf_test_records (cid, title, author_pubkey, signature, vector_json, timestamp, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              `perf-cid-${recordId}`,
              `Performance Test Record ${recordId}`,
              `author-${connIdx}`,
              `sig-${recordId}`,
              JSON.stringify([Math.random(), Math.random(), Math.random()]),
              Date.now(),
              Date.now() + 86400000,
            ]
          );
        } catch (err: any) {
          if (err.message && err.message.includes('busy')) {
            lockErrors.push(err);
          } else {
            throw err;
          }
        }
      }
    });

    await Promise.all(writePromises);
    const endTime = performance.now();

    // Close all connections
    await Promise.all(connections.map((c) => c.close()));

    // Verify all records were written
    const count = await db!.get('SELECT COUNT(*) as count FROM perf_test_records');
    const totalLatency = endTime - startTime;
    const throughput = (TOTAL_RECORDS / totalLatency) * 1000; // records/s
    const avgLatency = totalLatency / TOTAL_RECORDS;

    const report = {
      test: 'sqlite-concurrent-write',
      timestamp: new Date().toISOString(),
      config: {
        concurrentConnections: CONCURRENT_CONNECTIONS,
        recordsPerConnection: RECORDS_PER_CONNECTION,
        totalRecords: TOTAL_RECORDS,
        journalMode: 'WAL',
      },
      metrics: {
        totalLatencyMs: Number(totalLatency.toFixed(2)),
        avgLatencyMs: Number(avgLatency.toFixed(2)),
        throughputRecordsPerSec: Number(throughput.toFixed(2)),
        actualInserted: count.count,
        expectedInserted: TOTAL_RECORDS,
        lossRate: Number(((TOTAL_RECORDS - count.count) / TOTAL_RECORDS).toFixed(4)),
        lockErrors: lockErrors.length,
      },
    };

    console.log('[PERF-REPORT]', JSON.stringify(report, null, 2));

    expect(count.count).toBe(TOTAL_RECORDS);
    expect(lockErrors.length).toBe(0);
    expect(throughput).toBeGreaterThan(50);
  });

  it('should measure WAL mode vs rollback mode throughput', async () => {
    const RECORDS = 500;

    // Test WAL mode
    const walDbPath = path.resolve(process.cwd(), 'perf_wal_test.sqlite');
    [walDbPath, walDbPath + '-shm', walDbPath + '-wal'].forEach((f) => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });

    const walDb = await open({ filename: walDbPath, driver: sqlite3.Database });
    await walDb.exec('PRAGMA journal_mode = WAL;');
    await walDb.exec(`
      CREATE TABLE perf_test (id INTEGER PRIMARY KEY, data TEXT);
    `);

    const walStart = performance.now();
    for (let i = 0; i < RECORDS; i++) {
      await walDb.run('INSERT INTO perf_test (data) VALUES (?)', [`data-${i}`]);
    }
    const walLatency = performance.now() - walStart;
    await walDb.close();

    // Test ROLLBACK mode (DELETE)
    const rollbackDbPath = path.resolve(process.cwd(), 'perf_rollback_test.sqlite');
    [rollbackDbPath, rollbackDbPath + '-shm', rollbackDbPath + '-wal'].forEach((f) => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });

    const rollbackDb = await open({ filename: rollbackDbPath, driver: sqlite3.Database });
    await rollbackDb.exec('PRAGMA journal_mode = DELETE;');
    await rollbackDb.exec(`
      CREATE TABLE perf_test (id INTEGER PRIMARY KEY, data TEXT);
    `);

    const rollbackStart = performance.now();
    for (let i = 0; i < RECORDS; i++) {
      await rollbackDb.run('INSERT INTO perf_test (data) VALUES (?)', [`data-${i}`]);
    }
    const rollbackLatency = performance.now() - rollbackStart;
    await rollbackDb.close();

    const report = {
      test: 'sqlite-wal-vs-rollback',
      timestamp: new Date().toISOString(),
      config: {
        records: RECORDS,
      },
      metrics: {
        walLatencyMs: Number(walLatency.toFixed(2)),
        rollbackLatencyMs: Number(rollbackLatency.toFixed(2)),
        walThroughputRecPerSec: Number(((RECORDS / walLatency) * 1000).toFixed(2)),
        rollbackThroughputRecPerSec: Number(((RECORDS / rollbackLatency) * 1000).toFixed(2)),
        speedupFactor: Number((rollbackLatency / walLatency).toFixed(2)),
      },
    };

    console.log('[PERF-REPORT]', JSON.stringify(report, null, 2));

    // WAL should be faster than ROLLBACK mode
    expect(walLatency).toBeLessThan(rollbackLatency * 1.5);

    // Cleanup
    [walDbPath, walDbPath + '-shm', walDbPath + '-wal',
     rollbackDbPath, rollbackDbPath + '-shm', rollbackDbPath + '-wal'].forEach((f) => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
  });
});
