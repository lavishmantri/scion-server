import type { WebSocket } from '@fastify/websocket';

export interface WebSocketMessage {
  type: 'yjs-update' | 'structure-update' | 'binary-update' | 'ping' | 'pong' | 'sync-request' | 'sync-response' | 'error';
  vaultName: string;
  deviceId: string;
  fileId?: string;
  payload?: string; // base64 encoded
  timestamp: number;
  error?: string;
}

// Lazy imports to avoid circular dependency
let yjsSyncModule: typeof import('./yjs-sync.js') | null = null;
async function getYjsSync() {
  if (!yjsSyncModule) {
    yjsSyncModule = await import('./yjs-sync.js');
  }
  return yjsSyncModule;
}

let structureSyncModule: typeof import('./structure-sync.js') | null = null;
async function getStructureSync() {
  if (!structureSyncModule) {
    structureSyncModule = await import('./structure-sync.js');
  }
  return structureSyncModule;
}

export interface ConnectedClient {
  deviceId: string;
  vaultName: string;
  socket: WebSocket;
  lastSeen: number;
}

class WebSocketManager {
  private clients: Map<string, ConnectedClient[]> = new Map(); // vaultName -> clients
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private static readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private static readonly CLIENT_TIMEOUT = 60000; // 60 seconds

  constructor() {
    this.startHeartbeat();
  }

  /**
   * Handle a new WebSocket connection
   */
  handleConnection(socket: WebSocket, vaultName: string, deviceId: string): void {
    console.log(`[WS] Client connected: vault="${vaultName}" device="${deviceId}"`);

    const client: ConnectedClient = {
      deviceId,
      vaultName,
      socket,
      lastSeen: Date.now(),
    };

    // Add to vault's client list
    const vaultClients = this.clients.get(vaultName) || [];

    // Remove any existing connection from same device (reconnect scenario)
    const existingIndex = vaultClients.findIndex(c => c.deviceId === deviceId);
    if (existingIndex !== -1) {
      console.log(`[WS] Replacing existing connection for device="${deviceId}"`);
      const existing = vaultClients[existingIndex];
      try {
        existing.socket.close();
      } catch {
        // Ignore close errors
      }
      vaultClients.splice(existingIndex, 1);
    }

    vaultClients.push(client);
    this.clients.set(vaultName, vaultClients);

    // Set up message handler
    socket.on('message', (data: Buffer) => {
      this.handleMessage(client, data);
    });

    // Set up close handler
    socket.on('close', () => {
      this.handleDisconnect(vaultName, deviceId);
    });

    // Set up error handler
    socket.on('error', (error: Error) => {
      console.error(`[WS] Socket error for device="${deviceId}":`, error.message);
      this.handleDisconnect(vaultName, deviceId);
    });

    // Notify other clients about the new connection (optional awareness)
    this.broadcastClientCount(vaultName);
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(client: ConnectedClient, data: Buffer): void {
    client.lastSeen = Date.now();

    try {
      const message: WebSocketMessage = JSON.parse(data.toString());

      // Validate message
      if (!message.type || !message.deviceId) {
        console.warn(`[WS] Invalid message from device="${client.deviceId}": missing type or deviceId`);
        return;
      }

      switch (message.type) {
        case 'ping':
          // Respond with pong
          this.sendToClient(client, {
            type: 'pong',
            vaultName: client.vaultName,
            deviceId: 'server',
            timestamp: Date.now(),
          });
          break;

        case 'pong':
          // Client responded to our ping - already updated lastSeen
          break;

        case 'yjs-update':
          // Process Yjs update and broadcast to other clients
          if (message.fileId && message.payload) {
            this.handleYjsUpdateAsync(client, message);
          } else {
            console.warn(`[WS] Invalid yjs-update: missing fileId or payload`);
          }
          break;

        case 'structure-update':
          // Process structure CRDT update and broadcast
          if (message.payload) {
            this.handleStructureUpdateAsync(client, message);
          } else {
            console.warn(`[WS] Invalid structure-update: missing payload`);
          }
          break;

        case 'binary-update':
          // Broadcast to all other clients in the same vault
          console.log(`[WS] Broadcasting ${message.type} from device="${client.deviceId}" for file="${message.fileId || 'N/A'}"`);
          this.broadcast(client.vaultName, message, client.deviceId);
          break;

        case 'sync-request':
          // Client is requesting sync state - handled by sync layer
          console.log(`[WS] Sync request from device="${client.deviceId}"`);
          // This will be handled by yjs-sync.ts
          break;

        default:
          console.warn(`[WS] Unknown message type: ${message.type}`);
      }
    } catch (error) {
      console.error(`[WS] Failed to parse message from device="${client.deviceId}":`, error);
    }
  }

  /**
   * Handle Yjs update asynchronously (can't use async in switch statement)
   */
  private async handleYjsUpdateAsync(client: ConnectedClient, message: WebSocketMessage): Promise<void> {
    try {
      const yjsSync = await getYjsSync();

      // Decode the base64 payload to Uint8Array
      const update = new Uint8Array(Buffer.from(message.payload!, 'base64'));

      // Process the update
      const result = yjsSync.handleYjsUpdate(
        client.vaultName,
        message.fileId!,
        update,
        client.deviceId
      );

      if (!result.success) {
        console.error(`[WS] Yjs update failed: ${result.error}`);
        this.sendToClient(client, {
          type: 'error',
          vaultName: client.vaultName,
          deviceId: 'server',
          fileId: message.fileId,
          error: result.error,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      console.error(`[WS] Error handling Yjs update:`, error);
    }
  }

  /**
   * Handle structure CRDT update asynchronously
   */
  private async handleStructureUpdateAsync(client: ConnectedClient, message: WebSocketMessage): Promise<void> {
    try {
      const structureSync = await getStructureSync();

      // Decode the base64 payload to Uint8Array
      const update = new Uint8Array(Buffer.from(message.payload!, 'base64'));

      // Process the update
      const result = structureSync.handleStructureUpdate(
        client.vaultName,
        update,
        client.deviceId
      );

      if (!result.success) {
        console.error(`[WS] Structure update failed: ${result.error}`);
        this.sendToClient(client, {
          type: 'error',
          vaultName: client.vaultName,
          deviceId: 'server',
          error: result.error,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      console.error(`[WS] Error handling structure update:`, error);
    }
  }

  /**
   * Handle client disconnection
   */
  handleDisconnect(vaultName: string, deviceId: string): void {
    console.log(`[WS] Client disconnected: vault="${vaultName}" device="${deviceId}"`);

    const vaultClients = this.clients.get(vaultName);
    if (!vaultClients) return;

    const index = vaultClients.findIndex(c => c.deviceId === deviceId);
    if (index !== -1) {
      vaultClients.splice(index, 1);

      if (vaultClients.length === 0) {
        this.clients.delete(vaultName);
      } else {
        this.clients.set(vaultName, vaultClients);
        this.broadcastClientCount(vaultName);
      }
    }
  }

  /**
   * Broadcast a message to all clients in a vault except the sender
   */
  broadcast(vaultName: string, message: WebSocketMessage, excludeDeviceId?: string): void {
    const vaultClients = this.clients.get(vaultName);
    if (!vaultClients || vaultClients.length === 0) return;

    const messageStr = JSON.stringify(message);
    let sentCount = 0;

    for (const client of vaultClients) {
      if (excludeDeviceId && client.deviceId === excludeDeviceId) {
        continue;
      }

      try {
        if (client.socket.readyState === 1) { // OPEN
          client.socket.send(messageStr);
          sentCount++;
        }
      } catch (error) {
        console.error(`[WS] Failed to send to device="${client.deviceId}":`, error);
      }
    }

    if (sentCount > 0) {
      console.log(`[WS] Broadcast ${message.type} to ${sentCount} client(s) in vault="${vaultName}"`);
    }
  }

  /**
   * Send a message to a specific client
   */
  sendToClient(client: ConnectedClient, message: WebSocketMessage): void {
    try {
      if (client.socket.readyState === 1) { // OPEN
        client.socket.send(JSON.stringify(message));
      }
    } catch (error) {
      console.error(`[WS] Failed to send to device="${client.deviceId}":`, error);
    }
  }

  /**
   * Send a message to a specific device in a vault
   */
  sendToDevice(vaultName: string, deviceId: string, message: WebSocketMessage): boolean {
    const vaultClients = this.clients.get(vaultName);
    if (!vaultClients) return false;

    const client = vaultClients.find(c => c.deviceId === deviceId);
    if (!client) return false;

    this.sendToClient(client, message);
    return true;
  }

  /**
   * Broadcast current client count to all clients in a vault
   */
  private broadcastClientCount(vaultName: string): void {
    const vaultClients = this.clients.get(vaultName);
    const count = vaultClients?.length || 0;

    // Could be used for presence awareness
    console.log(`[WS] Vault "${vaultName}" now has ${count} connected client(s)`);
  }

  /**
   * Start heartbeat to check for dead connections
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();

      for (const [vaultName, vaultClients] of this.clients.entries()) {
        const activeClients: ConnectedClient[] = [];

        for (const client of vaultClients) {
          if (now - client.lastSeen > WebSocketManager.CLIENT_TIMEOUT) {
            // Client hasn't responded in too long
            console.log(`[WS] Closing stale connection: device="${client.deviceId}"`);
            try {
              client.socket.close();
            } catch {
              // Ignore
            }
          } else {
            // Send ping
            this.sendToClient(client, {
              type: 'ping',
              vaultName,
              deviceId: 'server',
              timestamp: now,
            });
            activeClients.push(client);
          }
        }

        if (activeClients.length === 0) {
          this.clients.delete(vaultName);
        } else {
          this.clients.set(vaultName, activeClients);
        }
      }
    }, WebSocketManager.HEARTBEAT_INTERVAL);
  }

  /**
   * Get all connected clients for a vault
   */
  getVaultClients(vaultName: string): ConnectedClient[] {
    return this.clients.get(vaultName) || [];
  }

  /**
   * Get count of connected clients for a vault
   */
  getClientCount(vaultName: string): number {
    return this.clients.get(vaultName)?.length || 0;
  }

  /**
   * Get all connected vaults
   */
  getConnectedVaults(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Close all connections
    for (const vaultClients of this.clients.values()) {
      for (const client of vaultClients) {
        try {
          client.socket.close();
        } catch {
          // Ignore
        }
      }
    }

    this.clients.clear();
    console.log('[WS] WebSocketManager destroyed');
  }
}

// Export singleton instance
export const wsManager = new WebSocketManager();
