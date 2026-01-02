import {
  getVaultStructure,
  uint8ArrayToBase64,
  base64ToUint8Array,
  type FileEntry,
  type StructureUpdate,
} from './structure-crdt.js';
import { wsManager, type WebSocketMessage } from './websocket.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Handle incoming structure update from a WebSocket client
 * Applies the update, persists it, and broadcasts to other clients
 */
export function handleStructureUpdate(
  vaultName: string,
  update: Uint8Array,
  fromDeviceId: string
): { success: boolean; error?: string } {
  try {
    console.log(`[StructureSync] Processing update for vault="${vaultName}" from device="${fromDeviceId}"`);

    const structure = getVaultStructure(vaultName);

    // Apply the update
    structure.applyUpdate(update);

    // Broadcast to other clients
    const broadcastMessage: WebSocketMessage = {
      type: 'structure-update',
      vaultName,
      deviceId: fromDeviceId,
      payload: uint8ArrayToBase64(update),
      timestamp: Date.now(),
    };

    wsManager.broadcast(vaultName, broadcastMessage, fromDeviceId);

    return { success: true };
  } catch (error) {
    console.error(`[StructureSync] Error processing update:`, error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Handle file creation - add to structure CRDT and broadcast
 */
export function handleFileCreate(
  vaultName: string,
  filePath: string,
  hash: string,
  fromDeviceId?: string
): { fileId: string; entry: FileEntry } {
  const structure = getVaultStructure(vaultName);

  // Generate new file ID
  const fileId = uuidv4();

  // Add to CRDT
  const entry = structure.addFile(fileId, filePath, 'file', hash);

  // Broadcast to all clients
  const update = structure.getFullState(); // Send full state for simplicity
  const broadcastMessage: WebSocketMessage = {
    type: 'structure-update',
    vaultName,
    deviceId: fromDeviceId || 'server',
    payload: uint8ArrayToBase64(update),
    timestamp: Date.now(),
  };

  wsManager.broadcast(vaultName, broadcastMessage, fromDeviceId);

  console.log(`[StructureSync] Created file: "${filePath}" (${fileId})`);
  return { fileId, entry };
}

/**
 * Handle file deletion - mark as deleted in CRDT and broadcast
 */
export function handleFileDelete(
  vaultName: string,
  fileId: string,
  fromDeviceId?: string
): boolean {
  const structure = getVaultStructure(vaultName);

  // Mark as deleted in CRDT
  const success = structure.deleteFile(fileId);
  if (!success) {
    return false;
  }

  // Broadcast to all clients
  const update = structure.getFullState();
  const broadcastMessage: WebSocketMessage = {
    type: 'structure-update',
    vaultName,
    deviceId: fromDeviceId || 'server',
    payload: uint8ArrayToBase64(update),
    timestamp: Date.now(),
  };

  wsManager.broadcast(vaultName, broadcastMessage, fromDeviceId);

  console.log(`[StructureSync] Deleted file: ${fileId}`);
  return true;
}

/**
 * Handle file rename/move - update path in CRDT and broadcast
 */
export function handleFileRename(
  vaultName: string,
  fileId: string,
  newPath: string,
  fromDeviceId?: string
): boolean {
  const structure = getVaultStructure(vaultName);

  // Update path in CRDT
  const success = structure.renameFile(fileId, newPath);
  if (!success) {
    return false;
  }

  // Broadcast to all clients
  const update = structure.getFullState();
  const broadcastMessage: WebSocketMessage = {
    type: 'structure-update',
    vaultName,
    deviceId: fromDeviceId || 'server',
    payload: uint8ArrayToBase64(update),
    timestamp: Date.now(),
  };

  wsManager.broadcast(vaultName, broadcastMessage, fromDeviceId);

  console.log(`[StructureSync] Renamed file: ${fileId} -> "${newPath}"`);
  return true;
}

/**
 * Get file entry by ID
 */
export function getFileEntry(vaultName: string, fileId: string): FileEntry | undefined {
  const structure = getVaultStructure(vaultName);
  return structure.getFile(fileId);
}

/**
 * Get file entry by path
 */
export function getFileEntryByPath(vaultName: string, filePath: string): FileEntry | undefined {
  const structure = getVaultStructure(vaultName);
  return structure.getFileByPath(filePath);
}

/**
 * Get all active files in the vault
 */
export function getActiveFiles(vaultName: string): FileEntry[] {
  const structure = getVaultStructure(vaultName);
  return structure.getActiveFiles();
}

/**
 * Get structure state for initial sync
 */
export function getStructureState(vaultName: string): Uint8Array {
  const structure = getVaultStructure(vaultName);
  return structure.getFullState();
}

/**
 * Get structure updates since client state vector
 */
export function getStructureUpdatesForClient(
  vaultName: string,
  clientStateVector: Uint8Array
): Uint8Array {
  const structure = getVaultStructure(vaultName);
  return structure.getUpdatesForClient(clientStateVector);
}

/**
 * Update file hash in structure CRDT
 */
export function updateFileHash(vaultName: string, fileId: string, hash: string): boolean {
  const structure = getVaultStructure(vaultName);
  return structure.updateFileHash(fileId, hash);
}

/**
 * Check if file exists in structure
 */
export function fileExists(vaultName: string, fileId: string): boolean {
  const structure = getVaultStructure(vaultName);
  return structure.hasFile(fileId);
}
