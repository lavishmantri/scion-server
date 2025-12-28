import { execSync } from 'child_process';
import path from 'path';
import fse from 'fs-extra';
import { createHash } from 'crypto';
import { config } from './config.js';

// Support absolute paths or resolve relative paths from cwd
export const VAULT_ROOT = path.isAbsolute(config.vaultPath)
  ? config.vaultPath
  : path.resolve(process.cwd(), config.vaultPath);

export interface FileRecord {
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
  const gitignore = '.DS_Store\nThumbs.db\n';
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
    files = output.split('\n').filter((f) => f && f !== '.gitignore');
  } catch {
    return [];
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

    records.push({
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

  return {
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
