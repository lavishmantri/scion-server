import { execSync } from 'child_process';
import path from 'path';
import fse from 'fs-extra';
import { createHash } from 'crypto';
import { config } from './config.js';
import {
  getDatabase,
  ensureFileId,
  getFileByPath,
  getFileById,
  updateFileRecord,
  recordPathChange,
  softDeleteFile,
  getAllPreviousPaths,
  detectRenameByHash,
  updateGitManifest,
  isVaultBootstrapped,
} from './metadata.js';

// Support absolute paths or resolve relative paths from cwd
export const VAULT_ROOT = path.isAbsolute(config.vaultPath)
  ? config.vaultPath
  : path.resolve(process.cwd(), config.vaultPath);

export interface FileRecord {
  file_id: string;  // UUID - persistent identity that survives renames
  path: string;
  hash: string;
  commit: string;
  updated_at: number;
}

export interface MergeResult {
  merged: Buffer;
  hasConflicts: boolean;
}

// Vault name validation regex: alphanumeric, dashes, underscores, spaces
const VALID_VAULT_NAME = /^[a-zA-Z0-9_\- ]+$/;

/**
 * Validate vault name to prevent path traversal attacks
 */
export function validateVaultName(vaultName: string): boolean {
  if (!vaultName || vaultName.length === 0 || vaultName.length > 100) {
    return false;
  }
  if (!VALID_VAULT_NAME.test(vaultName)) {
    return false;
  }
  if (vaultName.includes('..') || vaultName.includes('/') || vaultName.includes('\\')) {
    return false;
  }
  return true;
}

/**
 * Get the file storage path for a vault (this is the git repo root)
 */
export function getVaultPath(vaultName: string): string {
  return path.join(VAULT_ROOT, vaultName);
}

/**
 * Execute a git command in the vault directory
 */
function git(vaultName: string, args: string): string {
  const vaultPath = getVaultPath(vaultName);
  try {
    const result = execSync(`git ${args}`, {
      cwd: vaultPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (error: unknown) {
    const execError = error as { stderr?: string; message?: string };
    const stderr = execError.stderr || execError.message || 'Unknown git error';
    throw new Error(`Git command failed: git ${args}\n${stderr}`);
  }
}

/**
 * Initialize git repo for a vault if not already initialized
 */
export function initVaultGit(vaultName: string): void {
  if (!validateVaultName(vaultName)) {
    throw new Error(`Invalid vault name: ${vaultName}`);
  }

  const vaultPath = getVaultPath(vaultName);
  fse.ensureDirSync(vaultPath);

  const gitDir = path.join(vaultPath, '.git');
  if (fse.existsSync(gitDir)) {
    console.log(`Git: Vault "${vaultName}" already initialized`);
    return;
  }

  // Initialize git repo
  execSync('git init', { cwd: vaultPath, stdio: 'pipe' });

  // Configure git user for this repo
  execSync('git config user.email "scion-sync@local"', { cwd: vaultPath, stdio: 'pipe' });
  execSync('git config user.name "Scion Sync"', { cwd: vaultPath, stdio: 'pipe' });

  // Create .gitignore
  // Note: .scion/manifest.json is tracked for disaster recovery
  // SQLite database and WAL files are ignored
  const gitignore = `.DS_Store
Thumbs.db
.scion/metadata.db
.scion/metadata.db-wal
.scion/metadata.db-shm
`;
  fse.writeFileSync(path.join(vaultPath, '.gitignore'), gitignore);

  // Initial commit
  execSync('git add .gitignore', { cwd: vaultPath, stdio: 'pipe' });
  execSync('git commit -m "Initialize vault"', { cwd: vaultPath, stdio: 'pipe' });

  console.log(`Git: Initialized vault "${vaultName}" at ${vaultPath}`);
}

/**
 * Get the current HEAD commit hash
 */
export function getHeadCommit(vaultName: string): string | null {
  try {
    return git(vaultName, 'rev-parse HEAD');
  } catch {
    return null;
  }
}

/**
 * Commit a file to the vault
 * Returns the new commit hash
 */
export function commitFile(
  vaultName: string,
  filePath: string,
  content: Buffer,
  message: string
): string {
  initVaultGit(vaultName); // Ensure git is initialized

  const vaultPath = getVaultPath(vaultName);
  const fullPath = path.join(vaultPath, filePath);

  // Ensure parent directory exists
  fse.ensureDirSync(path.dirname(fullPath));

  // Write file
  fse.writeFileSync(fullPath, content);

  // Stage and commit
  git(vaultName, `add "${filePath}"`);

  try {
    git(vaultName, `commit -m "${message.replace(/"/g, '\\"')}"`);
  } catch (error: unknown) {
    // Check if it's "nothing to commit" error
    const execError = error as { message?: string };
    if (execError.message?.includes('nothing to commit')) {
      // File unchanged, return current HEAD
      return getHeadCommit(vaultName) || '';
    }
    throw error;
  }

  return getHeadCommit(vaultName) || '';
}

/**
 * Get file content at a specific commit
 */
export function getFileAtCommit(
  vaultName: string,
  filePath: string,
  commitHash: string
): Buffer | null {
  try {
    const content = execSync(`git show "${commitHash}:${filePath}"`, {
      cwd: getVaultPath(vaultName),
      encoding: 'buffer',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return content;
  } catch {
    return null;
  }
}

/**
 * Get current file content from working directory
 */
export function getCurrentFile(vaultName: string, filePath: string): Buffer | null {
  const fullPath = path.join(getVaultPath(vaultName), filePath);
  if (!fse.existsSync(fullPath)) {
    return null;
  }
  return fse.readFileSync(fullPath);
}

/**
 * Check if a file exists in the vault
 */
export function fileExists(vaultName: string, filePath: string): boolean {
  const fullPath = path.join(getVaultPath(vaultName), filePath);
  return fse.existsSync(fullPath);
}

/**
 * Perform a three-way merge using git merge-file
 */
export function mergeFile(
  vaultName: string,
  base: Buffer,
  local: Buffer,
  remote: Buffer
): MergeResult {
  const vaultPath = getVaultPath(vaultName);
  const tmpDir = path.join(vaultPath, '.tmp-merge');
  fse.ensureDirSync(tmpDir);

  const basePath = path.join(tmpDir, 'base');
  const localPath = path.join(tmpDir, 'local');
  const remotePath = path.join(tmpDir, 'remote');

  try {
    // Write temp files
    fse.writeFileSync(basePath, base);
    fse.writeFileSync(localPath, local);
    fse.writeFileSync(remotePath, remote);

    // Run git merge-file (modifies local in place)
    // Returns 0 if clean merge, >0 if conflicts, <0 on error
    try {
      execSync(`git merge-file -L "LOCAL" -L "BASE" -L "REMOTE" "${localPath}" "${basePath}" "${remotePath}"`, {
        cwd: vaultPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Clean merge
      const merged = fse.readFileSync(localPath);
      return { merged, hasConflicts: false };
    } catch (error: unknown) {
      const execError = error as { status?: number };
      if (execError.status && execError.status > 0) {
        // Conflicts present
        const merged = fse.readFileSync(localPath);
        return { merged, hasConflicts: true };
      }
      throw error;
    }
  } finally {
    // Cleanup temp files
    fse.removeSync(tmpDir);
  }
}

/**
 * Delete a file from the vault
 */
export function deleteFile(vaultName: string, filePath: string): boolean {
  const vaultPath = getVaultPath(vaultName);
  const fullPath = path.join(vaultPath, filePath);

  if (!fse.existsSync(fullPath)) {
    return false;
  }

  fse.removeSync(fullPath);

  try {
    git(vaultName, `add "${filePath}"`);
    git(vaultName, `commit -m "Delete ${filePath}"`);
  } catch {
    // File might not be tracked
  }

  return true;
}

/**
 * Bootstrap vault metadata - generates UUIDs for all existing files
 * Called automatically during getManifest if metadata doesn't exist
 */
export function bootstrapVaultMetadata(vaultName: string): void {
  console.log(`Bootstrapping metadata for vault "${vaultName}"...`);

  const vaultPath = getVaultPath(vaultName);

  // Get list of tracked files
  let files: string[];
  try {
    const output = git(vaultName, 'ls-files');
    files = output.split('\n').filter((f) => f && f !== '.gitignore' && !f.startsWith('.scion/'));
  } catch {
    files = [];
  }

  // Initialize the database (creates tables)
  getDatabase(vaultName);

  for (const filePath of files) {
    const fullPath = path.join(vaultPath, filePath);
    if (!fse.existsSync(fullPath)) continue;

    const content = fse.readFileSync(fullPath);
    const hash = computeHash(content);

    let commit: string | null = null;
    try {
      commit = git(vaultName, `log -1 --format=%H -- "${filePath}"`);
    } catch {
      // File might not be committed yet
    }

    // This will create a new UUID if one doesn't exist
    ensureFileId(vaultName, filePath, hash, commit);
  }

  // Persist UUID mapping to Git for disaster recovery
  updateGitManifest(vaultName);

  // Commit the manifest file
  try {
    git(vaultName, 'add .scion/manifest.json');
    git(vaultName, 'commit -m "Initialize Scion metadata"');
  } catch {
    // Might already be committed or nothing to commit
  }

  console.log(`Bootstrapped ${files.length} files for vault "${vaultName}"`);
}

/**
 * Get manifest of all files in the vault
 */
export function getManifest(vaultName: string): FileRecord[] {
  initVaultGit(vaultName);

  const vaultPath = getVaultPath(vaultName);
  const headCommit = getHeadCommit(vaultName);

  if (!headCommit) {
    return [];
  }

  // Get list of tracked files
  let files: string[];
  try {
    const output = git(vaultName, 'ls-files');
    files = output.split('\n').filter((f) => f && f !== '.gitignore' && !f.startsWith('.scion/'));
  } catch {
    return [];
  }

  // Check if we need to bootstrap metadata (only once per vault)
  if (files.length > 0 && !isVaultBootstrapped(vaultName)) {
    bootstrapVaultMetadata(vaultName);
  }

  const records: FileRecord[] = [];

  for (const filePath of files) {
    const fullPath = path.join(vaultPath, filePath);
    if (!fse.existsSync(fullPath)) continue;

    // Get file hash
    const content = fse.readFileSync(fullPath);
    const hash = computeHash(content);

    // Get last commit time for this file
    let updatedAt: number;
    try {
      const timestamp = git(vaultName, `log -1 --format=%ct -- "${filePath}"`);
      updatedAt = parseInt(timestamp, 10);
    } catch {
      updatedAt = Math.floor(Date.now() / 1000);
    }

    // Get last commit hash for this file
    let commit: string;
    try {
      commit = git(vaultName, `log -1 --format=%H -- "${filePath}"`);
    } catch {
      commit = headCommit;
    }

    // Get or create file_id from metadata store
    const fileId = ensureFileId(vaultName, filePath, hash, commit);

    records.push({
      file_id: fileId,
      path: filePath,
      hash,
      commit,
      updated_at: updatedAt,
    });
  }

  return records;
}

/**
 * Get files changed since a specific commit
 */
export function getChangesSince(
  vaultName: string,
  sinceCommit: string | null
): { headCommit: string; changedFiles: string[] } {
  initVaultGit(vaultName);

  const headCommit = getHeadCommit(vaultName);
  if (!headCommit) {
    return { headCommit: '', changedFiles: [] };
  }

  if (!sinceCommit || sinceCommit === headCommit) {
    return { headCommit, changedFiles: [] };
  }

  try {
    // Get list of changed files between commits
    const output = git(vaultName, `diff --name-only ${sinceCommit} ${headCommit}`);
    const changedFiles = output.split('\n').filter((f) => f && f !== '.gitignore');
    return { headCommit, changedFiles };
  } catch {
    // If sinceCommit doesn't exist, return all files
    const manifest = getManifest(vaultName);
    return {
      headCommit,
      changedFiles: manifest.map((f) => f.path),
    };
  }
}

/**
 * Get file record for a specific file
 */
export function getFileRecord(vaultName: string, filePath: string): FileRecord | undefined {
  const vaultPath = getVaultPath(vaultName);
  const fullPath = path.join(vaultPath, filePath);

  if (!fse.existsSync(fullPath)) {
    return undefined;
  }

  const content = fse.readFileSync(fullPath);
  const hash = computeHash(content);

  let commit: string;
  try {
    commit = git(vaultName, `log -1 --format=%H -- "${filePath}"`);
  } catch {
    commit = getHeadCommit(vaultName) || '';
  }

  let updatedAt: number;
  try {
    const timestamp = git(vaultName, `log -1 --format=%ct -- "${filePath}"`);
    updatedAt = parseInt(timestamp, 10);
  } catch {
    updatedAt = Math.floor(Date.now() / 1000);
  }

  // Get or create file_id from metadata store
  const fileId = ensureFileId(vaultName, filePath, hash, commit);

  return {
    file_id: fileId,
    path: filePath,
    hash,
    commit,
    updated_at: updatedAt,
  };
}

/**
 * Compute SHA-256 hash of content
 */
export function computeHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Detect if a missing file was renamed
 * Returns the new location if found
 */
export function detectRename(
  vaultName: string,
  missingPath: string,
  contentHash: string,
  fileId?: string
): { found: boolean; newPath?: string; fileId?: string; method?: string } {
  // Strategy 1: If file_id provided, check metadata for current path
  if (fileId) {
    const metadata = getFileById(vaultName, fileId);
    if (metadata && metadata.current_path !== missingPath && !metadata.deleted_at) {
      return {
        found: true,
        newPath: metadata.current_path,
        fileId: metadata.file_id,
        method: 'file_id',
      };
    }
  }

  // Strategy 2: Check hash index for exact content match
  const matchedFile = detectRenameByHash(vaultName, missingPath, contentHash);
  if (matchedFile) {
    return {
      found: true,
      newPath: matchedFile.current_path,
      fileId: matchedFile.file_id,
      method: 'hash_match',
    };
  }

  // Strategy 3: Check path history (file might have been renamed multiple times)
  const vaultPath = getVaultPath(vaultName);

  // First get all files and check their path history
  const allFiles = getManifest(vaultName);
  for (const file of allFiles) {
    const previousPaths = getAllPreviousPaths(vaultName, file.file_id);
    if (previousPaths.includes(missingPath)) {
      return {
        found: true,
        newPath: file.path,
        fileId: file.file_id,
        method: 'path_history',
      };
    }
  }

  return { found: false };
}

/**
 * Rename a file atomically using git mv
 * Returns the new commit hash and updated file record
 */
export function renameFile(
  vaultName: string,
  fileId: string,
  oldPath: string,
  newPath: string,
  newContent?: Buffer
): { success: boolean; commit: string; error?: string } {
  initVaultGit(vaultName);

  const vaultPath = getVaultPath(vaultName);
  const oldFullPath = path.join(vaultPath, oldPath);
  const newFullPath = path.join(vaultPath, newPath);

  // Verify the file exists at old path
  if (!fse.existsSync(oldFullPath)) {
    return { success: false, commit: '', error: 'File not found at old path' };
  }

  // Verify file_id matches
  const metadata = getFileById(vaultName, fileId);
  if (!metadata) {
    return { success: false, commit: '', error: 'File ID not found in metadata' };
  }

  if (metadata.current_path !== oldPath) {
    return { success: false, commit: '', error: 'File ID does not match old path' };
  }

  try {
    // Ensure parent directory of new path exists
    fse.ensureDirSync(path.dirname(newFullPath));

    // Use git mv for proper rename tracking
    git(vaultName, `mv "${oldPath}" "${newPath}"`);

    // If new content provided, write it
    if (newContent) {
      fse.writeFileSync(newFullPath, newContent);
      git(vaultName, `add "${newPath}"`);
    }

    // Commit the rename
    git(vaultName, `commit -m "Rename ${oldPath} to ${newPath}"`);

    const commit = getHeadCommit(vaultName) || '';
    const hash = newContent
      ? computeHash(newContent)
      : computeHash(fse.readFileSync(newFullPath));

    // Update metadata
    recordPathChange(vaultName, fileId, oldPath, newPath);
    updateFileRecord(vaultName, fileId, {
      current_path: newPath,
      content_hash: hash,
      git_commit: commit,
    });

    // Update Git manifest for disaster recovery
    updateGitManifest(vaultName);

    // Commit the updated manifest
    try {
      git(vaultName, 'add .scion/manifest.json');
      git(vaultName, 'commit --amend --no-edit');
    } catch {
      // Might fail if manifest unchanged
    }

    return { success: true, commit };
  } catch (error: unknown) {
    const execError = error as { message?: string };
    return { success: false, commit: '', error: execError.message || 'Unknown error' };
  }
}

/**
 * Get file at a commit, searching through path history if needed
 * Useful for three-way merge when file has been renamed
 */
export function getFileAtCommitWithHistory(
  vaultName: string,
  fileId: string,
  commitHash: string,
  currentPath: string
): Buffer | null {
  // First try the current path
  const content = getFileAtCommit(vaultName, currentPath, commitHash);
  if (content) {
    return content;
  }

  // Try all previous paths
  const previousPaths = getAllPreviousPaths(vaultName, fileId);
  for (const prevPath of previousPaths) {
    const prevContent = getFileAtCommit(vaultName, prevPath, commitHash);
    if (prevContent) {
      return prevContent;
    }
  }

  return null;
}
