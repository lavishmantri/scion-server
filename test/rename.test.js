/**
 * Rename handling tests
 * Tests for UUID-based file identity and rename detection
 */

const BASE_URL = 'http://localhost:3000';
const VAULT_NAME = 'RenameTestVault';

class SyncClient {
  constructor(name) {
    this.name = name;
    this.baseUrl = BASE_URL;
    this.vaultName = VAULT_NAME;
    this.syncState = {}; // path -> { file_id, hash, commit }
  }

  async upload(filePath, content) {
    const base64Content = Buffer.from(content).toString('base64');
    const state = this.syncState[filePath] || {};

    const response = await fetch(`${this.baseUrl}/vault/${this.vaultName}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: filePath,
        content: base64Content,
        base_commit: state.commit || null,
      }),
    });

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status}`);
    }

    const data = await response.json();
    this.syncState[filePath] = {
      file_id: data.file_id,
      hash: data.hash,
      commit: data.commit,
    };

    console.log(`   [${this.name}] Uploaded ${filePath} (file_id: ${data.file_id?.slice(0, 8)})`);
    return data;
  }

  async rename(fileId, oldPath, newPath, newContent = null) {
    const body = {
      file_id: fileId,
      old_path: oldPath,
      new_path: newPath,
    };

    if (newContent) {
      body.content = Buffer.from(newContent).toString('base64');
    }

    const response = await fetch(`${this.baseUrl}/vault/${this.vaultName}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(`Rename failed: ${err.error}`);
    }

    const data = await response.json();

    // Update local state
    delete this.syncState[oldPath];
    this.syncState[newPath] = {
      file_id: data.file_id,
      hash: data.hash,
      commit: data.commit,
    };

    console.log(`   [${this.name}] Renamed ${oldPath} -> ${newPath}`);
    return data;
  }

  async detectRename(missingPath, missingHash, fileId = null) {
    const body = {
      missing_path: missingPath,
      missing_hash: missingHash,
    };
    if (fileId) {
      body.file_id = fileId;
    }

    const response = await fetch(`${this.baseUrl}/vault/${this.vaultName}/detect-rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Detect rename failed: ${response.status}`);
    }

    return response.json();
  }

  async getManifest() {
    const response = await fetch(`${this.baseUrl}/vault/${this.vaultName}/manifest`);
    if (!response.ok) {
      throw new Error(`Get manifest failed: ${response.status}`);
    }

    const data = await response.json();

    // Update sync state from manifest
    for (const file of data.files) {
      this.syncState[file.path] = {
        file_id: file.file_id,
        hash: file.hash,
        commit: file.commit,
      };
    }

    console.log(`   [${this.name}] Synced state from manifest (${data.files.length} files)`);
    return data;
  }

  async delete(filePath) {
    const response = await fetch(
      `${this.baseUrl}/vault/${this.vaultName}/file/${encodeURIComponent(filePath)}`,
      { method: 'DELETE' }
    );
    if (!response.ok) {
      throw new Error(`Delete failed: ${response.status}`);
    }

    delete this.syncState[filePath];
    console.log(`   [${this.name}] Deleted ${filePath}`);
    return response.json();
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

// Test: manifest returns file_id
test('Manifest returns file_id for each file', async () => {
  const client = new SyncClient('Client');

  // Upload a file
  const uploadResult = await client.upload('test-fileid.md', 'test content');
  assert(uploadResult.file_id, 'Upload should return file_id');

  // Get manifest
  const manifest = await client.getManifest();
  assert(manifest.files.length > 0, 'Manifest should have files');

  const file = manifest.files.find((f) => f.path === 'test-fileid.md');
  assert(file, 'File should be in manifest');
  assert(file.file_id, 'File should have file_id');
  assert(file.file_id === uploadResult.file_id, 'file_id should match upload response');

  await client.delete('test-fileid.md');
});

// Test: file_id persists across content updates
test('file_id persists across content updates', async () => {
  const client = new SyncClient('Client');

  // Upload initial version
  const v1 = await client.upload('test-persist.md', 'version 1');
  const originalFileId = v1.file_id;

  // Update content
  const v2 = await client.upload('test-persist.md', 'version 2');

  assert(v2.file_id === originalFileId, 'file_id should persist after update');
  assert(v2.hash !== v1.hash, 'hash should change after update');

  await client.delete('test-persist.md');
});

// Test: rename updates path but keeps file_id
test('Rename keeps file_id, updates path', async () => {
  const client = new SyncClient('Client');

  // Upload file
  const upload = await client.upload('original-name.md', 'test content');
  const fileId = upload.file_id;

  // Rename
  const renameResult = await client.rename(fileId, 'original-name.md', 'new-name.md');

  assert(renameResult.file_id === fileId, 'file_id should be preserved after rename');

  // Verify in manifest
  const manifest = await client.getManifest();
  const oldFile = manifest.files.find((f) => f.path === 'original-name.md');
  const newFile = manifest.files.find((f) => f.path === 'new-name.md');

  assert(!oldFile, 'Old path should not exist in manifest');
  assert(newFile, 'New path should exist in manifest');
  assert(newFile.file_id === fileId, 'file_id should match at new path');

  await client.delete('new-name.md');
});

// Test: rename with content change
test('Rename with content change', async () => {
  const client = new SyncClient('Client');

  // Upload file
  const upload = await client.upload('rename-edit.md', 'original content');
  const fileId = upload.file_id;
  const originalHash = upload.hash;

  // Rename with new content
  const renameResult = await client.rename(
    fileId,
    'rename-edit.md',
    'renamed-edited.md',
    'new content'
  );

  assert(renameResult.file_id === fileId, 'file_id should be preserved');
  assert(renameResult.hash !== originalHash, 'hash should change with new content');

  await client.delete('renamed-edited.md');
});

// Test: detect rename by hash
test('Detect rename by hash match', async () => {
  const client = new SyncClient('Client');

  // Upload file
  const upload = await client.upload('detect-original.md', 'unique content for detection');
  const fileId = upload.file_id;
  const hash = upload.hash;

  // Rename the file
  await client.rename(fileId, 'detect-original.md', 'detect-renamed.md');

  // Create a new client (simulates another device)
  const client2 = new SyncClient('Client2');

  // Client2 tries to detect where the file went
  const detection = await client2.detectRename('detect-original.md', hash);

  assert(detection.found, 'Should detect renamed file');
  assert(detection.new_path === 'detect-renamed.md', 'Should find new path');
  assert(detection.file_id === fileId, 'Should return correct file_id');

  await client.delete('detect-renamed.md');
});

// Test: detect rename by file_id
test('Detect rename by file_id', async () => {
  const client = new SyncClient('Client');

  // Upload file
  const upload = await client.upload('detect-id.md', 'content');
  const fileId = upload.file_id;
  const hash = upload.hash;

  // Rename with content change (hash will differ)
  await client.rename(fileId, 'detect-id.md', 'detect-id-new.md', 'different content');

  // Client2 tries to detect using file_id
  const client2 = new SyncClient('Client2');
  const detection = await client2.detectRename('detect-id.md', hash, fileId);

  assert(detection.found, 'Should detect renamed file by file_id');
  assert(detection.new_path === 'detect-id-new.md', 'Should find new path');
  assert(detection.detection_method === 'file_id', 'Should use file_id method');

  await client.delete('detect-id-new.md');
});

// Test: nested folder rename
test('Rename to nested folder', async () => {
  const client = new SyncClient('Client');

  // Upload file
  const upload = await client.upload('flat-file.md', 'content');
  const fileId = upload.file_id;

  // Rename to nested path
  await client.rename(fileId, 'flat-file.md', 'archive/2024/flat-file.md');

  // Verify
  const manifest = await client.getManifest();
  const file = manifest.files.find((f) => f.file_id === fileId);

  assert(file, 'File should exist');
  assert(file.path === 'archive/2024/flat-file.md', 'Path should be updated');

  await client.delete('archive/2024/flat-file.md');
});

async function run() {
  console.log('\n=== Rename Handling Tests ===\n');

  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✓ ${name}\n`);
      passed++;
    } catch (error) {
      console.log(`✗ ${name}`);
      console.log(`  Error: ${error.message}\n`);
      failed++;
    }
  }

  console.log(`\nRename Tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
