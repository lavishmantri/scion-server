import Fastify from 'fastify';
import cors from '@fastify/cors';
import path from 'path';
import fse from 'fs-extra';
import { config } from './config.js';
import {
  VAULT_ROOT,
  getManifest,
  getFileRecord,
  commitFile,
  deleteFile,
  computeHash,
  validateVaultName,
  getVaultPath,
  initVaultGit,
  getHeadCommit,
  getFileAtCommit,
  getCurrentFile,
  mergeFile,
  getChangesSince,
} from './db.js';

export const server = Fastify({
  logger: {
    level: config.logLevel,
  },
});

// Register CORS plugin (allow all origins for self-hosted use)
await server.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

// Ensure vault root directory exists
await fse.ensureDir(VAULT_ROOT);

// Type definitions for route params
interface VaultParams {
  vaultName: string;
}

interface VaultFileParams extends VaultParams {
  '*': string;
}

// Health check (global)
server.get('/health', async () => {
  return { status: 'ok' };
});

// GET /vault/:vaultName/manifest - Return all files with their metadata
server.get<{ Params: VaultParams }>('/vault/:vaultName/manifest', async (request, reply) => {
  const { vaultName } = request.params;

  if (!validateVaultName(vaultName)) {
    return reply.status(400).send({ error: 'Invalid vault name' });
  }

  console.log(`Server: GET /vault/${vaultName}/manifest`);
  initVaultGit(vaultName);
  const files = getManifest(vaultName);
  const headCommit = getHeadCommit(vaultName);

  return { files, head_commit: headCommit };
});

// GET /vault/:vaultName/status - Get changes since a commit (for polling)
interface StatusQuery {
  since?: string;
}

server.get<{ Params: VaultParams; Querystring: StatusQuery }>(
  '/vault/:vaultName/status',
  async (request, reply) => {
    const { vaultName } = request.params;
    const { since } = request.query;

    if (!validateVaultName(vaultName)) {
      return reply.status(400).send({ error: 'Invalid vault name' });
    }

    console.log(`Server: GET /vault/${vaultName}/status?since=${since || 'null'}`);
    initVaultGit(vaultName);

    const { headCommit, changedFiles } = getChangesSince(vaultName, since || null);

    return {
      head_commit: headCommit,
      changed_files: changedFiles,
      has_changes: changedFiles.length > 0,
    };
  }
);

// GET /vault/:vaultName/file/* - Download file content
server.get<{ Params: VaultFileParams }>('/vault/:vaultName/file/*', async (request, reply) => {
  const { vaultName } = request.params;
  const filePath = request.params['*'];

  if (!validateVaultName(vaultName)) {
    return reply.status(400).send({ error: 'Invalid vault name' });
  }

  console.log(`Server: GET /vault/${vaultName}/file/${filePath}`);
  const record = getFileRecord(vaultName, filePath);

  if (!record) {
    return reply.status(404).send({ error: 'File not found' });
  }

  const content = getCurrentFile(vaultName, filePath);

  if (!content) {
    return reply.status(404).send({ error: 'File not found on disk' });
  }

  return reply
    .header('Content-Type', 'application/octet-stream')
    .header('X-File-Commit', record.commit)
    .header('X-File-Hash', record.hash)
    .send(content);
});

// POST /vault/:vaultName/sync - Upload/sync a file with three-way merge
interface SyncBody {
  path: string;
  content: string; // base64 encoded
  base_commit: string | null;
}

server.post<{ Params: VaultParams; Body: SyncBody }>(
  '/vault/:vaultName/sync',
  async (request, reply) => {
    const { vaultName } = request.params;
    const { path: filePath, content: base64Content, base_commit } = request.body;

    if (!validateVaultName(vaultName)) {
      return reply.status(400).send({ error: 'Invalid vault name' });
    }

    if (!filePath || base64Content === undefined) {
      return reply.status(400).send({ error: 'Missing path or content' });
    }

    console.log(`Server: POST /vault/${vaultName}/sync - ${filePath} (base_commit: ${base_commit || 'null'})`);
    initVaultGit(vaultName);

    // Decode base64 content
    const clientContent = Buffer.from(base64Content, 'base64');
    const clientHash = computeHash(clientContent);

    // Get current server state
    const headCommit = getHeadCommit(vaultName);
    const serverContent = getCurrentFile(vaultName, filePath);

    // Case 1: New file (doesn't exist on server)
    if (!serverContent) {
      console.log(`Server: New file ${filePath}, committing directly`);
      const commit = commitFile(vaultName, filePath, clientContent, `Add ${filePath}`);
      return {
        success: true,
        commit,
        hash: clientHash,
        merged: false,
        has_conflicts: false,
      };
    }

    // Case 2: Fast-forward (client is up to date with server)
    if (base_commit && base_commit === headCommit) {
      console.log(`Server: Fast-forward for ${filePath}`);
      const commit = commitFile(vaultName, filePath, clientContent, `Update ${filePath}`);
      return {
        success: true,
        commit,
        hash: clientHash,
        merged: false,
        has_conflicts: false,
      };
    }

    // Case 3: Client has no base_commit (first sync or reset)
    if (!base_commit) {
      // Check if content is the same
      const serverHash = computeHash(serverContent);
      if (clientHash === serverHash) {
        console.log(`Server: Content identical for ${filePath}, no commit needed`);
        const record = getFileRecord(vaultName, filePath);
        return {
          success: true,
          commit: record?.commit || headCommit,
          hash: clientHash,
          merged: false,
          has_conflicts: false,
        };
      }

      // Content differs, need merge but no base - use server as base
      console.log(`Server: No base_commit for ${filePath}, using server version as base`);
      const result = mergeFile(vaultName, serverContent, clientContent, serverContent);

      if (result.hasConflicts) {
        // Return merged content with conflict markers, don't commit yet
        return {
          success: true,
          commit: headCommit,
          hash: computeHash(result.merged),
          merged: true,
          has_conflicts: true,
          merged_content: result.merged.toString('base64'),
        };
      }

      // Clean merge
      const commit = commitFile(vaultName, filePath, result.merged, `Merge ${filePath}`);
      return {
        success: true,
        commit,
        hash: computeHash(result.merged),
        merged: true,
        has_conflicts: false,
        merged_content: result.merged.toString('base64'),
      };
    }

    // Case 4: Three-way merge needed
    console.log(`Server: Three-way merge needed for ${filePath}`);

    // Get base version
    const baseContent = getFileAtCommit(vaultName, filePath, base_commit);

    if (!baseContent) {
      // Base commit doesn't have this file, treat as new on both sides
      console.log(`Server: File didn't exist at base_commit, using empty base`);
      const result = mergeFile(vaultName, Buffer.from(''), clientContent, serverContent);

      if (result.hasConflicts) {
        return {
          success: true,
          commit: headCommit,
          hash: computeHash(result.merged),
          merged: true,
          has_conflicts: true,
          merged_content: result.merged.toString('base64'),
        };
      }

      const commit = commitFile(vaultName, filePath, result.merged, `Merge ${filePath}`);
      return {
        success: true,
        commit,
        hash: computeHash(result.merged),
        merged: true,
        has_conflicts: false,
        merged_content: result.merged.toString('base64'),
      };
    }

    // Perform three-way merge: base, client (local), server (remote)
    const result = mergeFile(vaultName, baseContent, clientContent, serverContent);

    if (result.hasConflicts) {
      console.log(`Server: Merge conflicts detected for ${filePath}`);
      // Return merged content with conflict markers, don't commit
      return {
        success: true,
        commit: headCommit,
        hash: computeHash(result.merged),
        merged: true,
        has_conflicts: true,
        merged_content: result.merged.toString('base64'),
      };
    }

    // Clean merge - commit the result
    console.log(`Server: Clean merge for ${filePath}`);
    const commit = commitFile(vaultName, filePath, result.merged, `Merge ${filePath}`);

    return {
      success: true,
      commit,
      hash: computeHash(result.merged),
      merged: true,
      has_conflicts: false,
      merged_content: result.merged.toString('base64'),
    };
  }
);

// DELETE /vault/:vaultName/file/* - Delete a file
server.delete<{ Params: VaultFileParams }>(
  '/vault/:vaultName/file/*',
  async (request, reply) => {
    const { vaultName } = request.params;
    const filePath = request.params['*'];

    if (!validateVaultName(vaultName)) {
      return reply.status(400).send({ error: 'Invalid vault name' });
    }

    console.log(`Server: DELETE /vault/${vaultName}/file/${filePath}`);

    const deleted = deleteFile(vaultName, filePath);

    if (!deleted) {
      return reply.status(404).send({ error: 'File not found' });
    }

    return { success: true, commit: getHeadCommit(vaultName) };
  }
);
