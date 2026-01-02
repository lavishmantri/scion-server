import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fse from 'fs-extra';
import { VAULT_ROOT } from './db.js';

const SCION_DIR = '.scion';
const DB_FILE = 'metadata.db';
const MANIFEST_FILE = 'manifest.json';

// Database instances cache (one per vault)
const dbCache = new Map<string, Database.Database>();

export interface FileMetadata {
  file_id: string;
  vault_id: string;
  current_path: string;
  content_hash: string | null;
  git_commit: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface PathHistoryEntry {
  id: number;
  file_id: string;
  old_path: string;
  new_path: string;
  changed_at: number;
}

export interface GitManifest {
  version: number;
  vault_id: string;
  files: Record<string, { path: string; created_at: number }>;
  updated_at: number;
}

/**
 * Get the .scion directory path for a vault
 */
export function getScionDir(vaultName: string): string {
  return path.join(VAULT_ROOT, vaultName, SCION_DIR);
}

/**
 * Check if the vault metadata has been bootstrapped
 */
export function isVaultBootstrapped(vaultName: string): boolean {
  const dbPath = getDbPath(vaultName);
  if (!fse.existsSync(dbPath)) {
    return false;
  }

  try {
    const db = getDatabase(vaultName);
    const stmt = db.prepare('SELECT COUNT(*) as count FROM files WHERE vault_id = ?');
    const result = stmt.get(vaultName) as { count: number } | undefined;
    return (result?.count || 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Get the SQLite database path for a vault
 */
function getDbPath(vaultName: string): string {
  return path.join(getScionDir(vaultName), DB_FILE);
}

/**
 * Get the Git manifest path for a vault (committed to Git for disaster recovery)
 */
export function getManifestPath(vaultName: string): string {
  return path.join(VAULT_ROOT, vaultName, SCION_DIR, MANIFEST_FILE);
}

/**
 * Initialize or get the database for a vault
 */
export function getDatabase(vaultName: string): Database.Database {
  const cached = dbCache.get(vaultName);
  if (cached) {
    return cached;
  }

  const scionDir = getScionDir(vaultName);
  fse.ensureDirSync(scionDir);

  const dbPath = getDbPath(vaultName);
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');

  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      file_id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      current_path TEXT NOT NULL,
      content_hash TEXT,
      git_commit TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS path_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL,
      old_path TEXT NOT NULL,
      new_path TEXT NOT NULL,
      changed_at INTEGER NOT NULL,
      FOREIGN KEY (file_id) REFERENCES files(file_id)
    );

    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);
    CREATE INDEX IF NOT EXISTS idx_files_path ON files(vault_id, current_path);
    CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_path_history_file ON path_history(file_id);
  `);

  dbCache.set(vaultName, db);
  return db;
}

/**
 * Close database connection for a vault
 */
export function closeDatabase(vaultName: string): void {
  const db = dbCache.get(vaultName);
  if (db) {
    db.close();
    dbCache.delete(vaultName);
  }
}

/**
 * Generate a new UUID for a file
 */
export function generateFileId(): string {
  return uuidv4();
}

/**
 * Create a new file record
 */
export function createFileRecord(
  vaultName: string,
  filePath: string,
  contentHash: string | null = null,
  gitCommit: string | null = null
): FileMetadata {
  const db = getDatabase(vaultName);
  const now = Math.floor(Date.now() / 1000);
  const fileId = generateFileId();

  const stmt = db.prepare(`
    INSERT INTO files (file_id, vault_id, current_path, content_hash, git_commit, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `);

  stmt.run(fileId, vaultName, filePath, contentHash, gitCommit, now, now);

  // Update Git manifest for disaster recovery
  updateGitManifest(vaultName);

  return {
    file_id: fileId,
    vault_id: vaultName,
    current_path: filePath,
    content_hash: contentHash,
    git_commit: gitCommit,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}

/**
 * Get file metadata by file_id
 */
export function getFileById(vaultName: string, fileId: string): FileMetadata | null {
  const db = getDatabase(vaultName);
  const stmt = db.prepare('SELECT * FROM files WHERE file_id = ?');
  const row = stmt.get(fileId) as FileMetadata | undefined;
  return row || null;
}

/**
 * Get file metadata by current path
 */
export function getFileByPath(vaultName: string, filePath: string): FileMetadata | null {
  const db = getDatabase(vaultName);
  const stmt = db.prepare('SELECT * FROM files WHERE vault_id = ? AND current_path = ? AND deleted_at IS NULL');
  const row = stmt.get(vaultName, filePath) as FileMetadata | undefined;
  return row || null;
}

/**
 * Get files by content hash (for rename detection)
 */
export function getFilesByHash(vaultName: string, contentHash: string): FileMetadata[] {
  const db = getDatabase(vaultName);
  const stmt = db.prepare('SELECT * FROM files WHERE vault_id = ? AND content_hash = ? AND deleted_at IS NULL');
  return stmt.all(vaultName, contentHash) as FileMetadata[];
}

/**
 * Update file metadata
 */
export function updateFileRecord(
  vaultName: string,
  fileId: string,
  updates: Partial<Pick<FileMetadata, 'current_path' | 'content_hash' | 'git_commit'>>
): boolean {
  const db = getDatabase(vaultName);
  const now = Math.floor(Date.now() / 1000);

  const setClauses: string[] = ['updated_at = ?'];
  const values: (string | number | null)[] = [now];

  if (updates.current_path !== undefined) {
    setClauses.push('current_path = ?');
    values.push(updates.current_path);
  }
  if (updates.content_hash !== undefined) {
    setClauses.push('content_hash = ?');
    values.push(updates.content_hash);
  }
  if (updates.git_commit !== undefined) {
    setClauses.push('git_commit = ?');
    values.push(updates.git_commit);
  }

  values.push(fileId);

  const stmt = db.prepare(`UPDATE files SET ${setClauses.join(', ')} WHERE file_id = ?`);
  const result = stmt.run(...values);

  if (result.changes > 0 && updates.current_path !== undefined) {
    // Path changed, update Git manifest
    updateGitManifest(vaultName);
  }

  return result.changes > 0;
}

/**
 * Record a path change (rename/move)
 */
export function recordPathChange(
  vaultName: string,
  fileId: string,
  oldPath: string,
  newPath: string
): void {
  const db = getDatabase(vaultName);
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO path_history (file_id, old_path, new_path, changed_at)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(fileId, oldPath, newPath, now);
}

/**
 * Get path history for a file
 */
export function getPathHistory(vaultName: string, fileId: string): PathHistoryEntry[] {
  const db = getDatabase(vaultName);
  const stmt = db.prepare('SELECT * FROM path_history WHERE file_id = ? ORDER BY changed_at DESC');
  return stmt.all(fileId) as PathHistoryEntry[];
}

/**
 * Get all previous paths for a file (useful for merge base resolution)
 */
export function getAllPreviousPaths(vaultName: string, fileId: string): string[] {
  const history = getPathHistory(vaultName, fileId);
  const paths = new Set<string>();

  for (const entry of history) {
    paths.add(entry.old_path);
  }

  return Array.from(paths);
}

/**
 * Soft delete a file (mark as deleted)
 */
export function softDeleteFile(vaultName: string, fileId: string): boolean {
  const db = getDatabase(vaultName);
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare('UPDATE files SET deleted_at = ?, updated_at = ? WHERE file_id = ?');
  const result = stmt.run(now, now, fileId);

  if (result.changes > 0) {
    updateGitManifest(vaultName);
  }

  return result.changes > 0;
}

/**
 * Restore a soft-deleted file
 */
export function restoreFile(vaultName: string, fileId: string): boolean {
  const db = getDatabase(vaultName);
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare('UPDATE files SET deleted_at = NULL, updated_at = ? WHERE file_id = ?');
  const result = stmt.run(now, fileId);

  if (result.changes > 0) {
    updateGitManifest(vaultName);
  }

  return result.changes > 0;
}

/**
 * Get all active (non-deleted) files in a vault
 */
export function getAllFiles(vaultName: string): FileMetadata[] {
  const db = getDatabase(vaultName);
  const stmt = db.prepare('SELECT * FROM files WHERE vault_id = ? AND deleted_at IS NULL');
  return stmt.all(vaultName) as FileMetadata[];
}

/**
 * Get or create file_id for a path
 * This is the main entry point for ensuring a file has a UUID
 */
export function ensureFileId(
  vaultName: string,
  filePath: string,
  contentHash: string | null = null,
  gitCommit: string | null = null
): string {
  // Check if file already has an ID
  const existing = getFileByPath(vaultName, filePath);
  if (existing) {
    // Update hash and commit if provided
    if (contentHash || gitCommit) {
      updateFileRecord(vaultName, existing.file_id, { content_hash: contentHash, git_commit: gitCommit });
    }
    return existing.file_id;
  }

  // Create new record
  const record = createFileRecord(vaultName, filePath, contentHash, gitCommit);
  return record.file_id;
}

/**
 * Update the Git manifest file (committed to Git for disaster recovery)
 * This ensures UUIDs can be recovered if SQLite is lost
 */
export function updateGitManifest(vaultName: string): void {
  const db = getDatabase(vaultName);
  const stmt = db.prepare('SELECT file_id, current_path, created_at FROM files WHERE vault_id = ? AND deleted_at IS NULL');
  const rows = stmt.all(vaultName) as Array<{ file_id: string; current_path: string; created_at: number }>;

  const manifest: GitManifest = {
    version: 1,
    vault_id: vaultName,
    files: {},
    updated_at: Math.floor(Date.now() / 1000),
  };

  for (const row of rows) {
    manifest.files[row.file_id] = {
      path: row.current_path,
      created_at: row.created_at,
    };
  }

  const manifestPath = getManifestPath(vaultName);
  fse.writeJsonSync(manifestPath, manifest, { spaces: 2 });
}

/**
 * Load Git manifest (for disaster recovery)
 */
export function loadGitManifest(vaultName: string): GitManifest | null {
  const manifestPath = getManifestPath(vaultName);
  if (!fse.existsSync(manifestPath)) {
    return null;
  }
  try {
    return fse.readJsonSync(manifestPath) as GitManifest;
  } catch {
    return null;
  }
}

/**
 * Rebuild SQLite from Git manifest (disaster recovery)
 */
export function rebuildFromManifest(vaultName: string): boolean {
  const manifest = loadGitManifest(vaultName);
  if (!manifest) {
    console.warn(`No manifest found for vault ${vaultName}`);
    return false;
  }

  const db = getDatabase(vaultName);
  const now = Math.floor(Date.now() / 1000);

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO files (file_id, vault_id, current_path, content_hash, git_commit, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL)
  `);

  const transaction = db.transaction(() => {
    for (const [fileId, data] of Object.entries(manifest.files)) {
      insertStmt.run(fileId, vaultName, data.path, data.created_at, now);
    }
  });

  transaction();
  console.log(`Rebuilt metadata for vault ${vaultName} from manifest: ${Object.keys(manifest.files).length} files`);
  return true;
}

/**
 * Detect rename by comparing hashes
 * Returns the file metadata if a file with matching hash exists at a different path
 */
export function detectRenameByHash(
  vaultName: string,
  missingPath: string,
  contentHash: string
): FileMetadata | null {
  const filesWithHash = getFilesByHash(vaultName, contentHash);

  // Filter out files at the same path
  const candidates = filesWithHash.filter(f => f.current_path !== missingPath);

  if (candidates.length === 1) {
    return candidates[0];
  }

  // Multiple matches - ambiguous, return null
  if (candidates.length > 1) {
    console.warn(`Ambiguous rename detection: ${candidates.length} files match hash ${contentHash}`);
  }

  return null;
}

/**
 * Find a file by checking both current path and historical paths
 */
export function findFileByAnyPath(vaultName: string, filePath: string): FileMetadata | null {
  // First check current path
  const current = getFileByPath(vaultName, filePath);
  if (current) {
    return current;
  }

  // Check path history
  const db = getDatabase(vaultName);
  const stmt = db.prepare(`
    SELECT f.* FROM files f
    INNER JOIN path_history ph ON f.file_id = ph.file_id
    WHERE f.vault_id = ? AND (ph.old_path = ? OR ph.new_path = ?) AND f.deleted_at IS NULL
    ORDER BY ph.changed_at DESC
    LIMIT 1
  `);

  const row = stmt.get(vaultName, filePath, filePath) as FileMetadata | undefined;
  return row || null;
}
