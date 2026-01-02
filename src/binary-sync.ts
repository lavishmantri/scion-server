import path from 'path';
import { computeHash, getCurrentFile, commitFile } from './db.js';
import { wsManager, type WebSocketMessage } from './websocket.js';

/**
 * Binary file extensions that should not use Yjs CRDT
 * These files will use hash comparison and conflict copies
 */
const BINARY_EXTENSIONS = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff', '.tif',
  // Documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  // Archives
  '.zip', '.tar', '.gz', '.7z', '.rar', '.bz2', '.xz',
  // Audio
  '.mp3', '.mp4', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma',
  // Video
  '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v',
  // Fonts
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // Other binary
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
  // Database
  '.sqlite', '.db', '.sqlite3',
]);

/**
 * Check if a file is binary based on extension
 */
export function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Result of binary file sync operation
 */
export interface BinarySyncResult {
  success: boolean;
  conflict: boolean;
  conflictPath?: string;
  hash: string;
  error?: string;
}

/**
 * Generate conflict filename
 * Format: filename.conflict-{deviceId}.ext
 */
export function generateConflictPath(originalPath: string, deviceId: string): string {
  const ext = path.extname(originalPath);
  const base = originalPath.slice(0, -ext.length || undefined);
  // Sanitize device ID for filesystem
  const safeDeviceId = deviceId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 16);
  return `${base}.conflict-${safeDeviceId}${ext}`;
}

/**
 * Sync a binary file with hash-based conflict detection
 * If content differs, creates a conflict copy
 */
export function syncBinaryFile(
  vaultName: string,
  filePath: string,
  content: Buffer,
  deviceId: string
): BinarySyncResult {
  try {
    const incomingHash = computeHash(content);
    console.log(`[BinarySync] Processing binary file: ${filePath} (${content.length} bytes, hash=${incomingHash.slice(0, 16)}...)`);

    // Get current server version
    const serverContent = getCurrentFile(vaultName, filePath);

    if (!serverContent) {
      // New file - just commit it
      commitFile(vaultName, filePath, content, `Add binary file ${filePath}`);
      console.log(`[BinarySync] Created new binary file: ${filePath}`);

      return {
        success: true,
        conflict: false,
        hash: incomingHash,
      };
    }

    const serverHash = computeHash(serverContent);

    if (serverHash === incomingHash) {
      // Same content - no action needed
      console.log(`[BinarySync] Binary file unchanged: ${filePath}`);
      return {
        success: true,
        conflict: false,
        hash: incomingHash,
      };
    }

    // Content differs - create conflict copy
    const conflictPath = generateConflictPath(filePath, deviceId);
    console.log(`[BinarySync] Binary conflict detected for ${filePath}, creating conflict copy: ${conflictPath}`);

    // Commit the incoming file as a conflict copy
    commitFile(vaultName, conflictPath, content, `Binary conflict copy from device ${deviceId}`);

    // Broadcast the binary update to other clients
    const broadcastMessage: WebSocketMessage = {
      type: 'binary-update',
      vaultName,
      deviceId,
      fileId: filePath, // Using path as ID for binary files
      payload: incomingHash,
      timestamp: Date.now(),
    };

    wsManager.broadcast(vaultName, broadcastMessage, deviceId);

    return {
      success: true,
      conflict: true,
      conflictPath,
      hash: serverHash, // Return server's hash since we kept server version
    };
  } catch (error) {
    console.error(`[BinarySync] Error syncing binary file:`, error);
    return {
      success: false,
      conflict: false,
      hash: '',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Handle binary file deletion
 */
export function handleBinaryDelete(vaultName: string, filePath: string, deviceId: string): boolean {
  try {
    console.log(`[BinarySync] Handling binary file deletion: ${filePath}`);

    // Broadcast the deletion to other clients
    const broadcastMessage: WebSocketMessage = {
      type: 'binary-update',
      vaultName,
      deviceId,
      fileId: filePath,
      payload: 'deleted',
      timestamp: Date.now(),
    };

    wsManager.broadcast(vaultName, broadcastMessage, deviceId);

    return true;
  } catch (error) {
    console.error(`[BinarySync] Error handling binary delete:`, error);
    return false;
  }
}

/**
 * Get all binary extensions
 */
export function getBinaryExtensions(): string[] {
  return Array.from(BINARY_EXTENSIONS);
}
