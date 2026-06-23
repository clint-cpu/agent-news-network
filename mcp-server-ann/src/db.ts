import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import os from 'os';
import fs from 'fs';

let db: Database | null = null;

export function resolveDbPath(): string {
  const configured = process.env.ANN_DB_PATH;
  if (configured && configured.trim().length > 0) {
    return path.resolve(configured);
  }

  const annDir = process.env.ANN_IDENTITY_DIR || path.join(os.homedir(), '.ann');
  return path.join(annDir, 'local_ann_ledger.sqlite');
}

export async function getDb(): Promise<Database> {
  if (db) return db;

  const dbPath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Added expires_at for Aether-like TTL Garbage Collection
  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS global_index (
      cid TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author_pubkey TEXT NOT NULL,
      signature TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      status TEXT,
      related_cid TEXT,
      artifacts_json TEXT,
      timestamp INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_chunks (
      chunk_id TEXT PRIMARY KEY,
      cid TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      data BLOB NOT NULL,
      timestamp INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_cid ON local_chunks(cid);
    CREATE INDEX IF NOT EXISTS idx_expires_index ON global_index(expires_at);
    CREATE INDEX IF NOT EXISTS idx_expires_chunks ON local_chunks(expires_at);

    CREATE TABLE IF NOT EXISTS published_cids (
      cid TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_published_cids_expires ON published_cids(expires_at);

    CREATE TABLE IF NOT EXISTS help_requests (
      request_id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      context_summary TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      urgency TEXT NOT NULL,
      constraints TEXT,
      author_pubkey TEXT NOT NULL,
      signature TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_help_requests_expires ON help_requests(expires_at);
    CREATE INDEX IF NOT EXISTS idx_help_requests_timestamp ON help_requests(timestamp);

    CREATE TABLE IF NOT EXISTS help_answers (
      answer_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      answer TEXT NOT NULL,
      confidence TEXT NOT NULL,
      artifacts_json TEXT NOT NULL,
      related_cid TEXT,
      author_pubkey TEXT NOT NULL,
      signature TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_help_answers_request ON help_answers(request_id);
    CREATE INDEX IF NOT EXISTS idx_help_answers_expires ON help_answers(expires_at);
  `);

  console.log('[DB] Local ledger initialized with TTL support at', dbPath);
  return db;
}

export async function insertGlobalIndex(payload: any) {
  const database = await getDb();
  try {
    const artifactsJson = payload.artifacts ? JSON.stringify(payload.artifacts) : '[]';
    const signature = payload.signature ?? payload.sig;
    await database.run(
      `INSERT OR IGNORE INTO global_index (cid, title, author_pubkey, signature, vector_json, status, related_cid, artifacts_json, timestamp, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [payload.cid, payload.title, payload.author_pubkey, signature, payload.vector_json, payload.status || 'resolved', payload.related_cid || null, artifactsJson, payload.timestamp, payload.expires_at]
    );
  } catch (err) {
    console.error('[DB] Failed to insert global index:', err);
  }
}

/**
 * Aether-inspired Garbage Collection (TTL)
 * Deletes expired knowledge to prevent the P2P node from bloating the hard drive.
 */
export async function runGarbageCollection() {
  const database = await getDb();
  const now = Date.now();
  
  const deletedIndexes = await database.run(`DELETE FROM global_index WHERE expires_at < ?`, now);
  const deletedChunks = await database.run(`DELETE FROM local_chunks WHERE expires_at < ?`, now);
  await database.run(`DELETE FROM help_requests WHERE expires_at < ?`, now);
  await database.run(`DELETE FROM help_answers WHERE expires_at < ?`, now);
  
  if (deletedIndexes.changes && deletedIndexes.changes > 0) {
      console.log(`[GC] Cleaned up ${deletedIndexes.changes} expired indexes.`);
  }
  if (deletedChunks.changes && deletedChunks.changes > 0) {
      console.log(`[GC] Cleaned up ${deletedChunks.changes} expired content chunks.`);
  }
}

export async function insertHelpRequest(payload: any) {
  const database = await getDb();
  await database.run(
    `INSERT OR IGNORE INTO help_requests (request_id, question, context_summary, tags_json, urgency, constraints, author_pubkey, signature, timestamp, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.request_id,
      payload.question,
      payload.context_summary,
      JSON.stringify(payload.tags ?? []),
      payload.urgency,
      payload.constraints ?? null,
      payload.author_pubkey,
      payload.sig ?? payload.signature,
      payload.timestamp,
      payload.expires_at
    ]
  );
}

export async function insertHelpAnswer(payload: any) {
  const database = await getDb();
  await database.run(
    `INSERT OR IGNORE INTO help_answers (answer_id, request_id, answer, confidence, artifacts_json, related_cid, author_pubkey, signature, timestamp, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.answer_id,
      payload.request_id,
      payload.answer,
      payload.confidence,
      JSON.stringify(payload.artifacts ?? []),
      payload.related_cid ?? null,
      payload.author_pubkey,
      payload.sig ?? payload.signature,
      payload.timestamp,
      payload.expires_at
    ]
  );
}

export async function listHelpRequests(limit = 20): Promise<any[]> {
  const database = await getDb();
  return database.all(
    `SELECT * FROM help_requests WHERE expires_at > ? ORDER BY timestamp DESC LIMIT ?`,
    Date.now(),
    limit
  );
}

export async function listHelpAnswers(requestId?: string, limit = 20): Promise<any[]> {
  const database = await getDb();
  if (requestId && requestId.length > 0) {
    return database.all(
      `SELECT * FROM help_answers WHERE request_id = ? AND expires_at > ? ORDER BY timestamp DESC LIMIT ?`,
      requestId,
      Date.now(),
      limit
    );
  }
  return database.all(
    `SELECT * FROM help_answers WHERE expires_at > ? ORDER BY timestamp DESC LIMIT ?`,
    Date.now(),
    limit
  );
}

export async function listRecentBroadcasts(limit = 20): Promise<any[]> {
  const database = await getDb();
  return database.all(
    `SELECT cid, title, author_pubkey, status, related_cid, artifacts_json, timestamp, expires_at
     FROM global_index WHERE expires_at > ? ORDER BY timestamp DESC LIMIT ?`,
    Date.now(),
    limit
  );
}

/**
 * Deterministic Hash-based Similarity Search
 * Both query and stored vectors are generated by the SHA-256 embedding generator.
 * This is a deterministic hash-based dot product, not true semantic cosine similarity.
 */
export async function searchSimilarVectors(queryVector: number[], limit: number = 5): Promise<any[]> {
  const database = await getDb();
  const rows = await database.all(`SELECT * FROM global_index WHERE expires_at > ?`, Date.now());

  const results = rows.map(row => {
    const vec = JSON.parse(row.vector_json) as number[];
    let dotProduct = 0;
    for(let i = 0; i < Math.min(vec.length, queryVector.length); i++) {
        dotProduct += vec[i] * queryVector[i];
    }
    return { ...row, score: dotProduct };
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

export async function insertPublishedCid(cid: string, expires_at: number) {
  const database = await getDb();
  await database.run(
    `INSERT OR IGNORE INTO published_cids (cid, expires_at) VALUES (?, ?)`,
    [cid, expires_at]
  );
}

export async function getExpiredPublishedCids(): Promise<string[]> {
  const database = await getDb();
  const rows = await database.all(`SELECT cid FROM published_cids WHERE expires_at < ?`, Date.now());
  return rows.map(r => r.cid);
}

export async function deletePublishedCid(cid: string) {
  const database = await getDb();
  await database.run(`DELETE FROM published_cids WHERE cid = ?`, cid);
}
