import * as Y from 'yjs';
import Database from 'better-sqlite3';
import path from 'path';
import { config } from './config.js';

// Yjs document storage in SQLite - store alongside vault
const DB_PATH = path.join(config.vaultPath, '..', 'yjs-store.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    // Create yjs_documents table
    db.exec(`
      CREATE TABLE IF NOT EXISTS yjs_documents (
        file_id TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        state BLOB NOT NULL,
        state_vector BLOB,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (vault_id, file_id)
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_yjs_vault ON yjs_documents(vault_id)
    `);

    console.log('[YjsStore] Database initialized at:', DB_PATH);
  }
  return db;
}

export interface YjsDocumentRecord {
  file_id: string;
  vault_id: string;
  state: Buffer;
  state_vector: Buffer | null;
  updated_at: number;
}

/**
 * Get a Yjs document from storage
 */
export function getYjsDocument(vaultName: string, fileId: string): Y.Doc | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT state FROM yjs_documents WHERE vault_id = ? AND file_id = ?'
  ).get(vaultName, fileId) as { state: Buffer } | undefined;

  if (!row) {
    return null;
  }

  const doc = new Y.Doc();
  Y.applyUpdate(doc, row.state);
  return doc;
}

/**
 * Get the full state of a Yjs document as a binary update
 */
export function getYjsDocumentState(vaultName: string, fileId: string): Uint8Array | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT state FROM yjs_documents WHERE vault_id = ? AND file_id = ?'
  ).get(vaultName, fileId) as { state: Buffer } | undefined;

  if (!row) {
    return null;
  }

  return new Uint8Array(row.state);
}

/**
 * Get the state vector for a Yjs document
 */
export function getYjsStateVector(vaultName: string, fileId: string): Uint8Array | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT state_vector FROM yjs_documents WHERE vault_id = ? AND file_id = ?'
  ).get(vaultName, fileId) as { state_vector: Buffer | null } | undefined;

  if (!row || !row.state_vector) {
    return null;
  }

  return new Uint8Array(row.state_vector);
}

/**
 * Apply an update to a Yjs document and persist it
 * Returns the merged document
 */
export function applyYjsUpdate(vaultName: string, fileId: string, update: Uint8Array): Y.Doc {
  const db = getDb();

  // Get existing document or create new one
  let doc = getYjsDocument(vaultName, fileId);
  if (!doc) {
    doc = new Y.Doc();
  }

  // Apply the update
  Y.applyUpdate(doc, update);

  // Get the full state for storage
  const fullState = Y.encodeStateAsUpdate(doc);
  const stateVector = Y.encodeStateVector(doc);

  // Save to database
  db.prepare(`
    INSERT OR REPLACE INTO yjs_documents (vault_id, file_id, state, state_vector, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(vaultName, fileId, Buffer.from(fullState), Buffer.from(stateVector), Date.now());

  console.log(`[YjsStore] Applied update to vault="${vaultName}" file="${fileId}" state_size=${fullState.length}`);

  return doc;
}

/**
 * Create a new Yjs document from text content
 */
export function createYjsDocumentFromContent(vaultName: string, fileId: string, content: string): Y.Doc {
  const db = getDb();

  const doc = new Y.Doc();
  const text = doc.getText('content');
  text.insert(0, content);

  const fullState = Y.encodeStateAsUpdate(doc);
  const stateVector = Y.encodeStateVector(doc);

  db.prepare(`
    INSERT OR REPLACE INTO yjs_documents (vault_id, file_id, state, state_vector, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(vaultName, fileId, Buffer.from(fullState), Buffer.from(stateVector), Date.now());

  console.log(`[YjsStore] Created document for vault="${vaultName}" file="${fileId}" content_size=${content.length}`);

  return doc;
}

/**
 * Get the text content from a Yjs document
 */
export function getYjsDocumentContent(vaultName: string, fileId: string): string | null {
  const doc = getYjsDocument(vaultName, fileId);
  if (!doc) {
    return null;
  }

  return doc.getText('content').toString();
}

/**
 * Compute updates needed for a client based on their state vector
 */
export function getUpdatesForClient(vaultName: string, fileId: string, clientStateVector: Uint8Array): Uint8Array | null {
  const doc = getYjsDocument(vaultName, fileId);
  if (!doc) {
    return null;
  }

  // Encode only the updates the client doesn't have
  return Y.encodeStateAsUpdate(doc, clientStateVector);
}

/**
 * Delete a Yjs document
 */
export function deleteYjsDocument(vaultName: string, fileId: string): boolean {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM yjs_documents WHERE vault_id = ? AND file_id = ?'
  ).run(vaultName, fileId);

  console.log(`[YjsStore] Deleted document vault="${vaultName}" file="${fileId}"`);
  return result.changes > 0;
}

/**
 * Check if a Yjs document exists
 */
export function hasYjsDocument(vaultName: string, fileId: string): boolean {
  const db = getDb();
  const row = db.prepare(
    'SELECT 1 FROM yjs_documents WHERE vault_id = ? AND file_id = ?'
  ).get(vaultName, fileId);

  return !!row;
}

/**
 * Get all Yjs documents for a vault
 */
export function getAllYjsDocuments(vaultName: string): YjsDocumentRecord[] {
  const db = getDb();
  return db.prepare(
    'SELECT file_id, vault_id, state, state_vector, updated_at FROM yjs_documents WHERE vault_id = ?'
  ).all(vaultName) as YjsDocumentRecord[];
}

/**
 * Cleanup: Close database connection
 */
export function closeYjsStore(): void {
  if (db) {
    db.close();
    db = null;
    console.log('[YjsStore] Database closed');
  }
}
