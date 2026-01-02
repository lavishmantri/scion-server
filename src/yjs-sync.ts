import * as Y from 'yjs';
import {
  getYjsDocument,
  getYjsDocumentState,
  getYjsStateVector,
  applyYjsUpdate,
  createYjsDocumentFromContent,
  getYjsDocumentContent,
  getUpdatesForClient,
  hasYjsDocument,
  deleteYjsDocument,
} from './yjs-store.js';
import { wsManager, type WebSocketMessage } from './websocket.js';
import { getFileById, getFileByPath } from './metadata.js';
import { getCurrentFile, commitFile, computeHash } from './db.js';

/**
 * Handle an incoming Yjs update from a WebSocket client
 * Applies the update, persists it, and broadcasts to other clients
 */
export function handleYjsUpdate(
  vaultName: string,
  fileId: string,
  update: Uint8Array,
  fromDeviceId: string
): { success: boolean; error?: string } {
  try {
    console.log(`[YjsSync] Processing update for vault="${vaultName}" file="${fileId}" from device="${fromDeviceId}"`);

    // Apply the update to the stored document
    const doc = applyYjsUpdate(vaultName, fileId, update);

    // Get the text content and write to the actual file
    const content = doc.getText('content').toString();

    // Look up the file path from metadata
    const fileMeta = getFileById(vaultName, fileId);
    if (!fileMeta) {
      console.warn(`[YjsSync] File metadata not found for file_id="${fileId}"`);
      return { success: false, error: 'File metadata not found' };
    }

    // Commit the updated content to git
    const contentBuffer = Buffer.from(content, 'utf-8');
    const hash = computeHash(contentBuffer);
    commitFile(vaultName, fileMeta.current_path, contentBuffer, `Update ${fileMeta.current_path} via real-time sync`);

    console.log(`[YjsSync] Committed update for "${fileMeta.current_path}" hash=${hash.substring(0, 16)}...`);

    // Broadcast the update to all other connected clients
    const broadcastMessage: WebSocketMessage = {
      type: 'yjs-update',
      vaultName,
      deviceId: fromDeviceId,
      fileId,
      payload: Buffer.from(update).toString('base64'),
      timestamp: Date.now(),
    };

    wsManager.broadcast(vaultName, broadcastMessage, fromDeviceId);

    return { success: true };
  } catch (error) {
    console.error(`[YjsSync] Error processing update:`, error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Initialize a Yjs document for a file that doesn't have one yet
 * Used during migration or when a file is first synced
 */
export function initializeYjsDocument(
  vaultName: string,
  fileId: string,
  content: string
): Y.Doc {
  console.log(`[YjsSync] Initializing Yjs document for vault="${vaultName}" file="${fileId}"`);
  return createYjsDocumentFromContent(vaultName, fileId, content);
}

/**
 * Get the current state of a Yjs document for initial sync
 * If no Yjs document exists, creates one from the current file content
 */
export function getOrCreateYjsDocument(
  vaultName: string,
  fileId: string,
  filePath: string
): { state: Uint8Array; stateVector: Uint8Array } | null {
  // Check if Yjs document exists
  if (hasYjsDocument(vaultName, fileId)) {
    const state = getYjsDocumentState(vaultName, fileId);
    const stateVector = getYjsStateVector(vaultName, fileId);

    if (state && stateVector) {
      return { state, stateVector };
    }
  }

  // Create from file content
  const content = getCurrentFile(vaultName, filePath);
  if (!content) {
    console.warn(`[YjsSync] File not found: ${filePath}`);
    return null;
  }

  const doc = createYjsDocumentFromContent(vaultName, fileId, content.toString('utf-8'));
  const state = Y.encodeStateAsUpdate(doc);
  const stateVector = Y.encodeStateVector(doc);

  return { state, stateVector };
}

/**
 * Compute the diff between server state and client state vector
 * Returns only the updates the client needs
 */
export function computeYjsDiff(
  vaultName: string,
  fileId: string,
  clientStateVector: Uint8Array
): Uint8Array | null {
  return getUpdatesForClient(vaultName, fileId, clientStateVector);
}

/**
 * Handle file deletion - also delete the Yjs document
 */
export function handleYjsFileDelete(vaultName: string, fileId: string): void {
  console.log(`[YjsSync] Deleting Yjs document for vault="${vaultName}" file="${fileId}"`);
  deleteYjsDocument(vaultName, fileId);
}

/**
 * Handle file rename - Yjs documents are keyed by file_id, so no action needed
 * The document persists across renames since the file_id doesn't change
 */
export function handleYjsFileRename(
  vaultName: string,
  fileId: string,
  oldPath: string,
  newPath: string
): void {
  console.log(`[YjsSync] File renamed: "${oldPath}" -> "${newPath}" (file_id=${fileId})`);
  // No action needed - Yjs documents are keyed by file_id which is stable across renames
}

/**
 * Merge client content with server Yjs document
 * Used when client sends full content instead of Yjs update (fallback/migration)
 */
export function mergeContentWithYjs(
  vaultName: string,
  fileId: string,
  clientContent: string
): { mergedContent: string; update: Uint8Array } {
  let doc = getYjsDocument(vaultName, fileId);

  if (!doc) {
    // Create new document from client content
    doc = createYjsDocumentFromContent(vaultName, fileId, clientContent);
    const update = Y.encodeStateAsUpdate(doc);
    return { mergedContent: clientContent, update };
  }

  // Get current server content
  const serverContent = doc.getText('content').toString();

  // If content is identical, no merge needed
  if (serverContent === clientContent) {
    const update = Y.encodeStateAsUpdate(doc);
    return { mergedContent: clientContent, update };
  }

  // Simple merge strategy: replace content
  // In a more sophisticated implementation, we could use diff algorithms
  // to generate proper Yjs operations for the changes
  doc.transact(() => {
    const text = doc!.getText('content');
    text.delete(0, text.length);
    text.insert(0, clientContent);
  });

  // Save the updated document
  const fullState = Y.encodeStateAsUpdate(doc);
  applyYjsUpdate(vaultName, fileId, fullState);

  return { mergedContent: clientContent, update: fullState };
}

/**
 * Check if a file should use Yjs (text files only)
 */
export function shouldUseYjs(filePath: string): boolean {
  const textExtensions = [
    '.md', '.txt', '.json', '.yaml', '.yml', '.xml', '.html', '.htm',
    '.css', '.scss', '.less', '.js', '.ts', '.jsx', '.tsx',
    '.py', '.rb', '.php', '.java', '.c', '.cpp', '.h', '.hpp',
    '.go', '.rs', '.swift', '.kt', '.scala', '.sh', '.bash',
    '.sql', '.graphql', '.toml', '.ini', '.cfg', '.conf',
    '.csv', '.log', '.markdown', '.mdown', '.mkdn'
  ];

  const ext = filePath.toLowerCase().substring(filePath.lastIndexOf('.'));
  return textExtensions.includes(ext);
}
