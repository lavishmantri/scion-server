/**
 * V2 Sync Protocol - Operation handlers
 * Provides explicit operation types for create, modify, rename, and delete
 */

import {
  commitFile,
  deleteFile,
  computeHash,
  initVaultGit,
  getHeadCommit,
  getCurrentFile,
  mergeFile,
  getFileAtCommit,
  renameFile as gitRenameFile,
  getFileRecord,
} from './db.js';
import {
  ensureFileId,
  getFileById,
  getFileByPath,
  softDeleteFile,
} from './metadata.js';

// Operation types
export type OperationType = 'create' | 'modify' | 'rename' | 'delete';

export interface SyncOperation {
  type: OperationType;
  path: string;
  file_id?: string;
  old_path?: string;
  content?: string; // base64
  base_commit?: string | null;
}

export interface OperationResult {
  index: number;
  success: boolean;
  file_id?: string;
  commit?: string;
  hash?: string;
  error?: string;
  merged?: boolean;
  has_conflicts?: boolean;
  merged_content?: string;
}

/**
 * Process a single sync operation
 */
export function processOperation(
  vaultName: string,
  op: SyncOperation,
  index: number
): OperationResult {
  initVaultGit(vaultName);

  try {
    switch (op.type) {
      case 'create':
        return processCreate(vaultName, op, index);
      case 'modify':
        return processModify(vaultName, op, index);
      case 'rename':
        return processRename(vaultName, op, index);
      case 'delete':
        return processDelete(vaultName, op, index);
      default:
        return {
          index,
          success: false,
          error: `Unknown operation type: ${(op as SyncOperation).type}`,
        };
    }
  } catch (err) {
    return {
      index,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Create a new file
 */
function processCreate(
  vaultName: string,
  op: SyncOperation,
  index: number
): OperationResult {
  if (!op.content) {
    return { index, success: false, error: 'Content required for create operation' };
  }

  const serverContent = getCurrentFile(vaultName, op.path);
  if (serverContent) {
    return { index, success: false, error: `File already exists: ${op.path}` };
  }

  const clientContent = Buffer.from(op.content, 'base64');
  const clientHash = computeHash(clientContent);
  const commit = commitFile(vaultName, op.path, clientContent, `Add ${op.path}`);
  const fileId = ensureFileId(vaultName, op.path, clientHash, commit);

  return {
    index,
    success: true,
    file_id: fileId,
    commit,
    hash: clientHash,
    merged: false,
    has_conflicts: false,
  };
}

/**
 * Modify an existing file (with three-way merge support)
 */
function processModify(
  vaultName: string,
  op: SyncOperation,
  index: number
): OperationResult {
  if (!op.content) {
    return { index, success: false, error: 'Content required for modify operation' };
  }

  if (!op.file_id) {
    return { index, success: false, error: 'file_id required for modify operation' };
  }

  // Verify file exists
  const metadata = getFileById(vaultName, op.file_id);
  if (!metadata || metadata.deleted_at) {
    return { index, success: false, error: `File not found: ${op.file_id}` };
  }

  const clientContent = Buffer.from(op.content, 'base64');
  const clientHash = computeHash(clientContent);
  const headCommit = getHeadCommit(vaultName);
  const serverContent = getCurrentFile(vaultName, metadata.current_path);

  // Case 1: Fast-forward (client is up to date)
  if (op.base_commit && op.base_commit === headCommit) {
    const commit = commitFile(vaultName, metadata.current_path, clientContent, `Update ${metadata.current_path}`);
    const fileId = ensureFileId(vaultName, metadata.current_path, clientHash, commit);
    return {
      index,
      success: true,
      file_id: fileId,
      commit,
      hash: clientHash,
      merged: false,
      has_conflicts: false,
    };
  }

  // Case 2: Content identical - no commit needed
  if (serverContent && clientHash === computeHash(serverContent)) {
    const record = getFileRecord(vaultName, metadata.current_path);
    return {
      index,
      success: true,
      file_id: op.file_id,
      commit: record?.commit || headCommit || undefined,
      hash: clientHash,
      merged: false,
      has_conflicts: false,
    };
  }

  // Case 3: Three-way merge needed
  if (!serverContent) {
    // File deleted on server, recreate it
    const commit = commitFile(vaultName, metadata.current_path, clientContent, `Recreate ${metadata.current_path}`);
    const fileId = ensureFileId(vaultName, metadata.current_path, clientHash, commit);
    return {
      index,
      success: true,
      file_id: fileId,
      commit,
      hash: clientHash,
      merged: false,
      has_conflicts: false,
    };
  }

  // Get base version for three-way merge
  const baseContent = op.base_commit
    ? getFileAtCommit(vaultName, metadata.current_path, op.base_commit) || serverContent
    : serverContent;

  const result = mergeFile(vaultName, baseContent, clientContent, serverContent);

  if (result.hasConflicts) {
    const mergedHash = computeHash(result.merged);
    const fileId = ensureFileId(vaultName, metadata.current_path, mergedHash, headCommit);
    return {
      index,
      success: true,
      file_id: fileId,
      commit: headCommit || undefined,
      hash: mergedHash,
      merged: true,
      has_conflicts: true,
      merged_content: result.merged.toString('base64'),
    };
  }

  // Clean merge - commit
  const mergedHash = computeHash(result.merged);
  const commit = commitFile(vaultName, metadata.current_path, result.merged, `Merge ${metadata.current_path}`);
  const fileId = ensureFileId(vaultName, metadata.current_path, mergedHash, commit);

  return {
    index,
    success: true,
    file_id: fileId,
    commit,
    hash: mergedHash,
    merged: true,
    has_conflicts: false,
    merged_content: result.merged.toString('base64'),
  };
}

/**
 * Rename a file (with optional content change)
 */
function processRename(
  vaultName: string,
  op: SyncOperation,
  index: number
): OperationResult {
  if (!op.file_id) {
    return { index, success: false, error: 'file_id required for rename operation' };
  }

  if (!op.old_path) {
    return { index, success: false, error: 'old_path required for rename operation' };
  }

  const newContent = op.content ? Buffer.from(op.content, 'base64') : undefined;
  const result = gitRenameFile(vaultName, op.file_id, op.old_path, op.path, newContent);

  if (!result.success) {
    return { index, success: false, error: result.error };
  }

  const record = getFileRecord(vaultName, op.path);

  return {
    index,
    success: true,
    file_id: record?.file_id,
    commit: result.commit,
    hash: record?.hash,
    merged: false,
    has_conflicts: false,
  };
}

/**
 * Delete a file (soft delete)
 */
function processDelete(
  vaultName: string,
  op: SyncOperation,
  index: number
): OperationResult {
  if (!op.file_id) {
    return { index, success: false, error: 'file_id required for delete operation' };
  }

  // Verify file exists
  const metadata = getFileById(vaultName, op.file_id);
  if (!metadata) {
    return { index, success: false, error: `File not found: ${op.file_id}` };
  }

  // Soft delete in metadata
  softDeleteFile(vaultName, op.file_id);

  // Hard delete from git
  const deleted = deleteFile(vaultName, metadata.current_path);
  if (!deleted) {
    return { index, success: false, error: `Failed to delete file: ${metadata.current_path}` };
  }

  return {
    index,
    success: true,
    file_id: op.file_id,
    commit: getHeadCommit(vaultName) || undefined,
    merged: false,
    has_conflicts: false,
  };
}
