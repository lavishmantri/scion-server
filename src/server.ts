import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import path from 'path';
import fse from 'fs-extra';
import { wsManager, type WebSocketMessage } from './websocket.js';
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
  detectRename,
  renameFile,
  getFileAtCommitWithHistory,
} from './db.js';
import {
  getFileByPath,
  getFileById,
  ensureFileId,
  updateFileRecord as updateMetadata,
  softDeleteFile,
} from './metadata.js';
import {
  processOperation,
  type SyncOperation,
  type OperationResult,
} from './operations.js';

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

// Register WebSocket plugin
await server.register(websocket);

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

  // Debug logging for sync troubleshooting
  console.log(`[SYNC DEBUG] vault="${vaultName}" endpoint="/manifest"
  server_head="${headCommit}" file_count=${files.length}`);

  return { files, head_commit: headCommit };
});

// GET /vault/:vaultName/debug - Debug endpoint to check vault state
server.get<{ Params: VaultParams }>('/vault/:vaultName/debug', async (request, reply) => {
  const { vaultName } = request.params;

  if (!validateVaultName(vaultName)) {
    return reply.status(400).send({ error: 'Invalid vault name' });
  }

  initVaultGit(vaultName);
  const files = getManifest(vaultName);
  const headCommit = getHeadCommit(vaultName);

  // Get the latest file update time
  let lastModified: number | null = null;
  for (const file of files) {
    if (!lastModified || file.updated_at > lastModified) {
      lastModified = file.updated_at;
    }
  }

  return {
    vault_name: vaultName,
    head_commit: headCommit,
    file_count: files.length,
    last_modified: lastModified ? new Date(lastModified * 1000).toISOString() : null,
  };
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

    // Debug logging for sync troubleshooting
    console.log(`[SYNC DEBUG] vault="${vaultName}" endpoint="/status"
  client_since="${since || 'null'}" server_head="${headCommit}"
  commits_match=${since === headCommit} changed_files=${changedFiles.length > 0 ? JSON.stringify(changedFiles) : '[]'}`);

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
    console.log(`[SYNC DEBUG] vault="${vaultName}" endpoint="/file" path="${filePath}" status="not_found"`);
    return reply.status(404).send({ error: 'File not found' });
  }

  const content = getCurrentFile(vaultName, filePath);

  if (!content) {
    console.log(`[SYNC DEBUG] vault="${vaultName}" endpoint="/file" path="${filePath}" status="not_on_disk"`);
    return reply.status(404).send({ error: 'File not found on disk' });
  }

  // Debug logging for sync troubleshooting
  console.log(`[SYNC DEBUG] vault="${vaultName}" endpoint="/file" path="${filePath}"
  commit="${record.commit}" hash="${record.hash}" size=${content.length}`);

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

    // Debug logging for upload troubleshooting
    console.log(`[SYNC DEBUG] vault="${vaultName}" endpoint="/sync" UPLOAD_RECEIVED
  path="${filePath}" content_size=${clientContent.length} client_hash="${clientHash}"
  base_commit="${base_commit || 'null'}" server_head="${headCommit}"
  file_exists_on_server=${serverContent !== null}`);

    // Case 1: New file (doesn't exist on server)
    if (!serverContent) {
      console.log(`Server: New file ${filePath}, committing directly`);
      const commit = commitFile(vaultName, filePath, clientContent, `Add ${filePath}`);
      const fileId = ensureFileId(vaultName, filePath, clientHash, commit);
      console.log(`[SYNC DEBUG] vault="${vaultName}" COMMIT_CREATED case="new_file"
  path="${filePath}" new_commit="${commit}"`);
      return {
        success: true,
        commit,
        hash: clientHash,
        file_id: fileId,
        merged: false,
        has_conflicts: false,
      };
    }

    // Case 2: Fast-forward (client is up to date with server)
    if (base_commit && base_commit === headCommit) {
      console.log(`Server: Fast-forward for ${filePath}`);
      const commit = commitFile(vaultName, filePath, clientContent, `Update ${filePath}`);
      const fileId = ensureFileId(vaultName, filePath, clientHash, commit);
      console.log(`[SYNC DEBUG] vault="${vaultName}" COMMIT_CREATED case="fast_forward"
  path="${filePath}" new_commit="${commit}"`);
      return {
        success: true,
        commit,
        hash: clientHash,
        file_id: fileId,
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
        const fileId = ensureFileId(vaultName, filePath, clientHash, record?.commit || headCommit);
        console.log(`[SYNC DEBUG] vault="${vaultName}" NO_COMMIT_NEEDED case="content_identical"
  path="${filePath}" client_hash="${clientHash}" server_hash="${serverHash}"
  returning_commit="${record?.commit || headCommit}"`);
        return {
          success: true,
          commit: record?.commit || headCommit,
          hash: clientHash,
          file_id: fileId,
          merged: false,
          has_conflicts: false,
        };
      }

      // Content differs, need merge but no base - use server as base
      console.log(`Server: No base_commit for ${filePath}, using server version as base`);
      const result = mergeFile(vaultName, serverContent, clientContent, serverContent);

      if (result.hasConflicts) {
        // Return merged content with conflict markers, don't commit yet
        const fileId = ensureFileId(vaultName, filePath, computeHash(result.merged), headCommit);
        return {
          success: true,
          commit: headCommit,
          hash: computeHash(result.merged),
          file_id: fileId,
          merged: true,
          has_conflicts: true,
          merged_content: result.merged.toString('base64'),
        };
      }

      // Clean merge
      const commit = commitFile(vaultName, filePath, result.merged, `Merge ${filePath}`);
      const mergedHash = computeHash(result.merged);
      const fileId = ensureFileId(vaultName, filePath, mergedHash, commit);
      console.log(`[SYNC DEBUG] vault="${vaultName}" COMMIT_CREATED case="merge_no_base"
  path="${filePath}" new_commit="${commit}"`);
      return {
        success: true,
        commit,
        hash: mergedHash,
        file_id: fileId,
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
        const mergedHash = computeHash(result.merged);
        const fileId = ensureFileId(vaultName, filePath, mergedHash, headCommit);
        return {
          success: true,
          commit: headCommit,
          hash: mergedHash,
          file_id: fileId,
          merged: true,
          has_conflicts: true,
          merged_content: result.merged.toString('base64'),
        };
      }

      const commit = commitFile(vaultName, filePath, result.merged, `Merge ${filePath}`);
      const mergedHash = computeHash(result.merged);
      const fileId = ensureFileId(vaultName, filePath, mergedHash, commit);
      return {
        success: true,
        commit,
        hash: mergedHash,
        file_id: fileId,
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
      const mergedHash = computeHash(result.merged);
      const fileId = ensureFileId(vaultName, filePath, mergedHash, headCommit);
      return {
        success: true,
        commit: headCommit,
        hash: mergedHash,
        file_id: fileId,
        merged: true,
        has_conflicts: true,
        merged_content: result.merged.toString('base64'),
      };
    }

    // Clean merge - commit the result
    console.log(`Server: Clean merge for ${filePath}`);
    const commit = commitFile(vaultName, filePath, result.merged, `Merge ${filePath}`);
    const mergedHash = computeHash(result.merged);
    const fileId = ensureFileId(vaultName, filePath, mergedHash, commit);
    console.log(`[SYNC DEBUG] vault="${vaultName}" COMMIT_CREATED case="three_way_merge"
  path="${filePath}" new_commit="${commit}"`);

    return {
      success: true,
      commit,
      hash: mergedHash,
      file_id: fileId,
      merged: true,
      has_conflicts: false,
      merged_content: result.merged.toString('base64'),
    };
  }
);

// POST /vault/:vaultName/sync/v2 - V2 sync protocol with batch operations
interface V2SyncBody {
  operations: SyncOperation[];
  atomic?: boolean; // If true, all-or-nothing transaction (default: true)
}

interface V2SyncResponse {
  success: boolean;
  results: OperationResult[];
  head_commit: string;
}

server.post<{ Params: VaultParams; Body: V2SyncBody }>(
  '/vault/:vaultName/sync/v2',
  async (request, reply) => {
    const { vaultName } = request.params;
    const { operations, atomic = true } = request.body;

    if (!validateVaultName(vaultName)) {
      return reply.status(400).send({ error: 'Invalid vault name' });
    }

    if (!operations || !Array.isArray(operations) || operations.length === 0) {
      return reply.status(400).send({ error: 'operations array is required' });
    }

    console.log(`Server: POST /vault/${vaultName}/sync/v2 - ${operations.length} operation(s), atomic=${atomic}`);
    initVaultGit(vaultName);

    const results: OperationResult[] = [];
    const startCommit = getHeadCommit(vaultName);

    // Debug logging for V2 upload troubleshooting
    const opSummary = operations.map((op, i) => `${i}:${op.type}:${op.path}`).join(', ');
    console.log(`[SYNC DEBUG] vault="${vaultName}" endpoint="/sync/v2" UPLOAD_RECEIVED
  operation_count=${operations.length} atomic=${atomic} server_head="${startCommit}"
  operations=[${opSummary}]`);

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];

      // Validate operation structure
      if (!op.type || !op.path) {
        results.push({
          index: i,
          success: false,
          error: 'Operation requires type and path',
        });

        if (atomic) {
          // Rollback: reset to start commit
          console.log(`Server: Atomic rollback due to invalid operation at index ${i}`);
          return reply.status(400).send({
            success: false,
            results,
            head_commit: startCommit,
            error: `Operation ${i} failed: Operation requires type and path`,
          });
        }
        continue;
      }

      const result = processOperation(vaultName, op, i);
      results.push(result);

      if (!result.success && atomic) {
        // Rollback: In a real implementation, we'd use git reset
        // For now, we just fail the batch and return
        console.log(`Server: Atomic rollback due to failed operation at index ${i}: ${result.error}`);
        return reply.status(400).send({
          success: false,
          results,
          head_commit: startCommit,
          error: `Operation ${i} failed: ${result.error}`,
        });
      }
    }

    const allSucceeded = results.every((r) => r.success);
    const finalCommit = getHeadCommit(vaultName);

    // Debug logging for V2 completion
    const successCount = results.filter((r) => r.success).length;
    console.log(`[SYNC DEBUG] vault="${vaultName}" endpoint="/sync/v2" COMPLETED
  success=${allSucceeded} operations_succeeded=${successCount}/${results.length}
  start_commit="${startCommit}" final_commit="${finalCommit}"
  commit_changed=${startCommit !== finalCommit}`);

    return {
      success: allSucceeded,
      results,
      head_commit: finalCommit,
    } as V2SyncResponse;
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

    // Get file_id before deletion for metadata tracking
    const metadata = getFileByPath(vaultName, filePath);
    if (metadata) {
      softDeleteFile(vaultName, metadata.file_id);
    }

    const deleted = deleteFile(vaultName, filePath);

    if (!deleted) {
      return reply.status(404).send({ error: 'File not found' });
    }

    return { success: true, commit: getHeadCommit(vaultName) };
  }
);

// POST /vault/:vaultName/detect-rename - Detect if a file was renamed
interface DetectRenameBody {
  missing_path: string;
  missing_hash: string;
  file_id?: string;
}

server.post<{ Params: VaultParams; Body: DetectRenameBody }>(
  '/vault/:vaultName/detect-rename',
  async (request, reply) => {
    const { vaultName } = request.params;
    const { missing_path, missing_hash, file_id } = request.body;

    if (!validateVaultName(vaultName)) {
      return reply.status(400).send({ error: 'Invalid vault name' });
    }

    if (!missing_path || !missing_hash) {
      return reply.status(400).send({ error: 'Missing required fields: missing_path, missing_hash' });
    }

    console.log(`Server: POST /vault/${vaultName}/detect-rename - ${missing_path}`);

    const result = detectRename(vaultName, missing_path, missing_hash, file_id);

    return {
      found: result.found,
      new_path: result.newPath,
      file_id: result.fileId,
      detection_method: result.method,
    };
  }
);

// POST /vault/:vaultName/rename - Rename a file atomically
interface RenameBody {
  file_id: string;
  old_path: string;
  new_path: string;
  content?: string; // base64 encoded (optional - if content also changed)
}

server.post<{ Params: VaultParams; Body: RenameBody }>(
  '/vault/:vaultName/rename',
  async (request, reply) => {
    const { vaultName } = request.params;
    const { file_id, old_path, new_path, content } = request.body;

    if (!validateVaultName(vaultName)) {
      return reply.status(400).send({ error: 'Invalid vault name' });
    }

    if (!file_id || !old_path || !new_path) {
      return reply.status(400).send({ error: 'Missing required fields: file_id, old_path, new_path' });
    }

    console.log(`Server: POST /vault/${vaultName}/rename - ${old_path} -> ${new_path}`);

    const newContent = content ? Buffer.from(content, 'base64') : undefined;
    const result = renameFile(vaultName, file_id, old_path, new_path, newContent);

    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }

    const record = getFileRecord(vaultName, new_path);

    return {
      success: true,
      commit: result.commit,
      file_id: record?.file_id,
      hash: record?.hash,
    };
  }
);

// GET /vault/:vaultName/file-by-id/:fileId - Download file by UUID
interface FileByIdParams extends VaultParams {
  fileId: string;
}

server.get<{ Params: FileByIdParams }>('/vault/:vaultName/file-by-id/:fileId', async (request, reply) => {
  const { vaultName, fileId } = request.params;

  if (!validateVaultName(vaultName)) {
    return reply.status(400).send({ error: 'Invalid vault name' });
  }

  console.log(`Server: GET /vault/${vaultName}/file-by-id/${fileId}`);

  // Look up current path from metadata
  const fileMeta = getFileById(vaultName, fileId);

  if (!fileMeta || fileMeta.deleted_at) {
    return reply.status(404).send({ error: 'File not found' });
  }

  const record = getFileRecord(vaultName, fileMeta.current_path);
  if (!record) {
    return reply.status(404).send({ error: 'File not found on disk' });
  }

  const content = getCurrentFile(vaultName, fileMeta.current_path);
  if (!content) {
    return reply.status(404).send({ error: 'File content not found' });
  }

  return reply
    .header('Content-Type', 'application/octet-stream')
    .header('X-File-Id', record.file_id)
    .header('X-File-Path', record.path)
    .header('X-File-Commit', record.commit)
    .header('X-File-Hash', record.hash)
    .send(content);
});

// WebSocket endpoint for real-time sync
interface WsQuery {
  deviceId?: string;
}

server.get<{ Params: VaultParams; Querystring: WsQuery }>(
  '/vault/:vaultName/ws',
  { websocket: true },
  (socket, request) => {
    const { vaultName } = request.params;
    const deviceId = request.query.deviceId || `device-${Date.now()}`;

    if (!validateVaultName(vaultName)) {
      console.log(`[WS] Rejected connection: invalid vault name "${vaultName}"`);
      socket.close(1008, 'Invalid vault name');
      return;
    }

    console.log(`Server: WebSocket connection for vault="${vaultName}" device="${deviceId}"`);
    initVaultGit(vaultName);

    // Hand off to WebSocket manager
    wsManager.handleConnection(socket, vaultName, deviceId);
  }
);

// WebSocket status endpoint (for debugging)
server.get('/ws/status', async () => {
  const vaults = wsManager.getConnectedVaults();
  const status: Record<string, number> = {};

  for (const vault of vaults) {
    status[vault] = wsManager.getClientCount(vault);
  }

  return {
    connected_vaults: vaults.length,
    clients_by_vault: status,
  };
});

// Export WebSocket manager for use by other modules
export { wsManager };
