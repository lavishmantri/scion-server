import * as Y from 'yjs';
import Database from 'better-sqlite3';
import path from 'path';
import { config } from './config.js';

/**
 * Structure CRDT - Manages file/folder structure using Yjs Y.Map
 * Uses tombstone pattern for deletions (marked deleted, not removed)
 * Syncs via WebSocket to all connected clients
 */

// SQLite database for persisting structure CRDT
const DB_PATH = path.join(config.vaultPath, '..', 'structure-crdt.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    // Create structure_crdt table
    db.exec(`
      CREATE TABLE IF NOT EXISTS structure_crdt (
        vault_id TEXT PRIMARY KEY,
        state BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    console.log('[StructureCRDT] Database initialized at:', DB_PATH);
  }
  return db;
}

export interface FileEntry {
  file_id: string;
  path: string;
  type: 'file' | 'folder';
  deleted: boolean;
  created_at: number;
  modified_at: number;
  hash?: string; // For files only
}

export interface StructureUpdate {
  type: 'create' | 'delete' | 'rename' | 'move';
  file_id: string;
  path: string;
  old_path?: string;
  entry_type?: 'file' | 'folder';
}

/**
 * Manages structure CRDT for a single vault
 */
export class VaultStructureCRDT {
  private doc: Y.Doc;
  private files: Y.Map<FileEntry>;
  private vaultName: string;

  constructor(vaultName: string) {
    this.vaultName = vaultName;
    this.doc = new Y.Doc();
    this.files = this.doc.getMap('files');

    // Load persisted state if exists
    this.loadFromDb();

    console.log(`[StructureCRDT] Initialized for vault="${vaultName}" with ${this.files.size} entries`);
  }

  /**
   * Load CRDT state from database
   */
  private loadFromDb(): void {
    const db = getDb();
    const row = db.prepare(
      'SELECT state FROM structure_crdt WHERE vault_id = ?'
    ).get(this.vaultName) as { state: Buffer } | undefined;

    if (row) {
      Y.applyUpdate(this.doc, row.state);
      console.log(`[StructureCRDT] Loaded state for vault="${this.vaultName}"`);
    }
  }

  /**
   * Persist CRDT state to database
   */
  private saveToDb(): void {
    const db = getDb();
    const state = Y.encodeStateAsUpdate(this.doc);

    db.prepare(`
      INSERT OR REPLACE INTO structure_crdt (vault_id, state, updated_at)
      VALUES (?, ?, ?)
    `).run(this.vaultName, Buffer.from(state), Date.now());
  }

  /**
   * Get the current state vector for sync
   */
  getStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  /**
   * Get the full state for initial sync
   */
  getFullState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /**
   * Get updates since a given state vector
   */
  getUpdatesForClient(clientStateVector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, clientStateVector);
  }

  /**
   * Apply an update from another client/server
   */
  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update);
    this.saveToDb();
  }

  /**
   * Add a new file or folder to the structure
   */
  addFile(fileId: string, filePath: string, entryType: 'file' | 'folder', hash?: string): FileEntry {
    const now = Date.now();
    const entry: FileEntry = {
      file_id: fileId,
      path: filePath,
      type: entryType,
      deleted: false,
      created_at: now,
      modified_at: now,
      hash,
    };

    this.doc.transact(() => {
      this.files.set(fileId, entry);
    });

    this.saveToDb();
    console.log(`[StructureCRDT] Added ${entryType}: "${filePath}" (${fileId})`);
    return entry;
  }

  /**
   * Mark a file as deleted (tombstone pattern)
   */
  deleteFile(fileId: string): boolean {
    const entry = this.files.get(fileId);
    if (!entry) {
      console.warn(`[StructureCRDT] Cannot delete, file not found: ${fileId}`);
      return false;
    }

    const updatedEntry: FileEntry = {
      ...entry,
      deleted: true,
      modified_at: Date.now(),
    };

    this.doc.transact(() => {
      this.files.set(fileId, updatedEntry);
    });

    this.saveToDb();
    console.log(`[StructureCRDT] Deleted: "${entry.path}" (${fileId})`);
    return true;
  }

  /**
   * Rename/move a file
   */
  renameFile(fileId: string, newPath: string): boolean {
    const entry = this.files.get(fileId);
    if (!entry) {
      console.warn(`[StructureCRDT] Cannot rename, file not found: ${fileId}`);
      return false;
    }

    const oldPath = entry.path;
    const updatedEntry: FileEntry = {
      ...entry,
      path: newPath,
      modified_at: Date.now(),
    };

    this.doc.transact(() => {
      this.files.set(fileId, updatedEntry);
    });

    this.saveToDb();
    console.log(`[StructureCRDT] Renamed: "${oldPath}" -> "${newPath}" (${fileId})`);
    return true;
  }

  /**
   * Update file hash (when content changes)
   */
  updateFileHash(fileId: string, hash: string): boolean {
    const entry = this.files.get(fileId);
    if (!entry) {
      console.warn(`[StructureCRDT] Cannot update hash, file not found: ${fileId}`);
      return false;
    }

    const updatedEntry: FileEntry = {
      ...entry,
      hash,
      modified_at: Date.now(),
    };

    this.doc.transact(() => {
      this.files.set(fileId, updatedEntry);
    });

    this.saveToDb();
    return true;
  }

  /**
   * Get a file entry by ID
   */
  getFile(fileId: string): FileEntry | undefined {
    return this.files.get(fileId);
  }

  /**
   * Get a file entry by path (searches non-deleted files)
   */
  getFileByPath(filePath: string): FileEntry | undefined {
    for (const entry of this.files.values()) {
      if (!entry.deleted && entry.path === filePath) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Get all non-deleted files
   */
  getActiveFiles(): FileEntry[] {
    const active: FileEntry[] = [];
    for (const entry of this.files.values()) {
      if (!entry.deleted) {
        active.push(entry);
      }
    }
    return active;
  }

  /**
   * Get all files including deleted (for debugging/recovery)
   */
  getAllFiles(): FileEntry[] {
    return Array.from(this.files.values());
  }

  /**
   * Check if a file exists (non-deleted)
   */
  hasFile(fileId: string): boolean {
    const entry = this.files.get(fileId);
    return entry !== undefined && !entry.deleted;
  }

  /**
   * Check if a path exists (non-deleted)
   */
  hasPath(filePath: string): boolean {
    return this.getFileByPath(filePath) !== undefined;
  }

  /**
   * Restore a deleted file (undo delete)
   */
  restoreFile(fileId: string): boolean {
    const entry = this.files.get(fileId);
    if (!entry) {
      console.warn(`[StructureCRDT] Cannot restore, file not found: ${fileId}`);
      return false;
    }

    if (!entry.deleted) {
      return true; // Already active
    }

    const updatedEntry: FileEntry = {
      ...entry,
      deleted: false,
      modified_at: Date.now(),
    };

    this.doc.transact(() => {
      this.files.set(fileId, updatedEntry);
    });

    this.saveToDb();
    console.log(`[StructureCRDT] Restored: "${entry.path}" (${fileId})`);
    return true;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.doc.destroy();
    console.log(`[StructureCRDT] Destroyed for vault="${this.vaultName}"`);
  }
}

// Cache of vault structure CRDTs
const vaultCrdts = new Map<string, VaultStructureCRDT>();

/**
 * Get or create the structure CRDT for a vault
 */
export function getVaultStructure(vaultName: string): VaultStructureCRDT {
  let crdt = vaultCrdts.get(vaultName);
  if (!crdt) {
    crdt = new VaultStructureCRDT(vaultName);
    vaultCrdts.set(vaultName, crdt);
  }
  return crdt;
}

/**
 * Close database connection
 */
export function closeStructureCrdtStore(): void {
  if (db) {
    db.close();
    db = null;
    console.log('[StructureCRDT] Database closed');
  }
}

/**
 * Convert Uint8Array to base64 string
 */
export function uint8ArrayToBase64(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return Buffer.from(binary, 'binary').toString('base64');
}

/**
 * Convert base64 string to Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = Buffer.from(base64, 'base64').toString('binary');
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    arr[i] = binary.charCodeAt(i);
  }
  return arr;
}
