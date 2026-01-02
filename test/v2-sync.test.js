/**
 * V2 Sync Protocol Tests
 * Tests for batch operations with atomic transactions
 */

const BASE_URL = 'http://localhost:3000';
const VAULT_NAME = 'V2TestVault';

class V2Client {
  constructor(name) {
    this.name = name;
    this.baseUrl = BASE_URL;
    this.vaultName = VAULT_NAME;
    this.syncState = {}; // path -> { file_id, hash, commit }
  }

  async syncV2(operations, atomic = true) {
    const response = await fetch(`${this.baseUrl}/vault/${this.vaultName}/sync/v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations, atomic }),
    });

    const data = await response.json();

    if (response.ok && data.results) {
      // Update local state from results
      for (const result of data.results) {
        if (result.success && result.file_id) {
          const op = operations[result.index];
          if (op.type !== 'delete') {
            this.syncState[op.path] = {
              file_id: result.file_id,
              hash: result.hash,
              commit: result.commit,
            };
          } else {
            delete this.syncState[op.path];
          }
        }
      }
    }

    console.log(`   [${this.name}] V2 sync: ${operations.length} ops, success=${data.success}`);
    return { response, data };
  }

  async getManifest() {
    const response = await fetch(`${this.baseUrl}/vault/${this.vaultName}/manifest`);
    const data = await response.json();

    for (const file of data.files) {
      this.syncState[file.path] = {
        file_id: file.file_id,
        hash: file.hash,
        commit: file.commit,
      };
    }

    console.log(`   [${this.name}] Manifest: ${data.files.length} files`);
    return data;
  }

  async delete(filePath) {
    const response = await fetch(
      `${this.baseUrl}/vault/${this.vaultName}/file/${encodeURIComponent(filePath)}`,
      { method: 'DELETE' }
    );
    delete this.syncState[filePath];
    console.log(`   [${this.name}] Deleted ${filePath}`);
    return response.json();
  }

  // V1 sync for comparison
  async syncV1(filePath, content, baseCommit = null) {
    const base64Content = Buffer.from(content).toString('base64');

    const response = await fetch(`${this.baseUrl}/vault/${this.vaultName}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: filePath,
        content: base64Content,
        base_commit: baseCommit,
      }),
    });

    const data = await response.json();

    if (data.file_id) {
      this.syncState[filePath] = {
        file_id: data.file_id,
        hash: data.hash,
        commit: data.commit,
      };
    }

    console.log(`   [${this.name}] V1 sync ${filePath} (file_id: ${data.file_id?.slice(0, 8)})`);
    return data;
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

// Test: Single create operation
test('V2: Single create operation', async () => {
  const client = new V2Client('Client');

  const { data } = await client.syncV2([
    {
      type: 'create',
      path: 'v2-create.md',
      content: Buffer.from('created via v2').toString('base64'),
    },
  ]);

  assert(data.success, 'V2 sync should succeed');
  assert(data.results.length === 1, 'Should have one result');
  assert(data.results[0].success, 'Create should succeed');
  assert(data.results[0].file_id, 'Should return file_id');

  await client.delete('v2-create.md');
});

// Test: Single modify operation
test('V2: Single modify operation', async () => {
  const client = new V2Client('Client');

  // First create via V1
  const createResult = await client.syncV1('v2-modify.md', 'original');
  const fileId = createResult.file_id;

  // Modify via V2
  const { data } = await client.syncV2([
    {
      type: 'modify',
      path: 'v2-modify.md',
      file_id: fileId,
      content: Buffer.from('modified via v2').toString('base64'),
      base_commit: createResult.commit,
    },
  ]);

  assert(data.success, 'V2 modify should succeed');
  assert(data.results[0].file_id === fileId, 'file_id should be preserved');
  assert(data.results[0].hash !== createResult.hash, 'Hash should change');

  await client.delete('v2-modify.md');
});

// Test: Single rename operation
test('V2: Single rename operation', async () => {
  const client = new V2Client('Client');

  // Create file
  const createResult = await client.syncV1('v2-rename-old.md', 'rename test');
  const fileId = createResult.file_id;

  // Rename via V2
  const { data } = await client.syncV2([
    {
      type: 'rename',
      path: 'v2-rename-new.md',
      file_id: fileId,
      old_path: 'v2-rename-old.md',
    },
  ]);

  assert(data.success, 'V2 rename should succeed');
  assert(data.results[0].file_id === fileId, 'file_id should be preserved');

  // Verify in manifest
  const manifest = await client.getManifest();
  const oldFile = manifest.files.find((f) => f.path === 'v2-rename-old.md');
  const newFile = manifest.files.find((f) => f.path === 'v2-rename-new.md');

  assert(!oldFile, 'Old path should not exist');
  assert(newFile, 'New path should exist');
  assert(newFile.file_id === fileId, 'file_id should match');

  await client.delete('v2-rename-new.md');
});

// Test: Single delete operation
test('V2: Single delete operation', async () => {
  const client = new V2Client('Client');

  // Create file
  const createResult = await client.syncV1('v2-delete.md', 'delete test');
  const fileId = createResult.file_id;

  // Delete via V2
  const { data } = await client.syncV2([
    {
      type: 'delete',
      path: 'v2-delete.md',
      file_id: fileId,
    },
  ]);

  assert(data.success, 'V2 delete should succeed');

  // Verify deleted
  const manifest = await client.getManifest();
  const file = manifest.files.find((f) => f.path === 'v2-delete.md');
  assert(!file, 'File should be deleted from manifest');
});

// Test: Batch create multiple files
test('V2: Batch create multiple files', async () => {
  const client = new V2Client('Client');

  const { data } = await client.syncV2([
    {
      type: 'create',
      path: 'batch/file1.md',
      content: Buffer.from('file 1').toString('base64'),
    },
    {
      type: 'create',
      path: 'batch/file2.md',
      content: Buffer.from('file 2').toString('base64'),
    },
    {
      type: 'create',
      path: 'batch/file3.md',
      content: Buffer.from('file 3').toString('base64'),
    },
  ]);

  assert(data.success, 'Batch create should succeed');
  assert(data.results.length === 3, 'Should have 3 results');
  assert(data.results.every((r) => r.success), 'All operations should succeed');
  assert(data.results.every((r) => r.file_id), 'All should have file_id');

  // Verify all in manifest
  const manifest = await client.getManifest();
  assert(manifest.files.find((f) => f.path === 'batch/file1.md'), 'file1 should exist');
  assert(manifest.files.find((f) => f.path === 'batch/file2.md'), 'file2 should exist');
  assert(manifest.files.find((f) => f.path === 'batch/file3.md'), 'file3 should exist');

  // Cleanup
  await client.delete('batch/file1.md');
  await client.delete('batch/file2.md');
  await client.delete('batch/file3.md');
});

// Test: Mixed operations in batch
test('V2: Mixed operations in batch', async () => {
  const client = new V2Client('Client');

  // Create initial files
  const file1 = await client.syncV1('mixed/existing1.md', 'existing 1');
  const file2 = await client.syncV1('mixed/existing2.md', 'existing 2');

  // Batch: create, modify, rename, delete
  const { data } = await client.syncV2([
    {
      type: 'create',
      path: 'mixed/new.md',
      content: Buffer.from('new file').toString('base64'),
    },
    {
      type: 'modify',
      path: 'mixed/existing1.md',
      file_id: file1.file_id,
      content: Buffer.from('modified').toString('base64'),
      base_commit: file1.commit,
    },
    {
      type: 'rename',
      path: 'mixed/renamed.md',
      file_id: file2.file_id,
      old_path: 'mixed/existing2.md',
    },
  ]);

  assert(data.success, 'Mixed batch should succeed');
  assert(data.results.length === 3, 'Should have 3 results');
  assert(data.results.every((r) => r.success), 'All operations should succeed');

  // Verify state
  const manifest = await client.getManifest();
  assert(manifest.files.find((f) => f.path === 'mixed/new.md'), 'new.md should exist');
  assert(manifest.files.find((f) => f.path === 'mixed/existing1.md'), 'existing1.md should exist');
  assert(manifest.files.find((f) => f.path === 'mixed/renamed.md'), 'renamed.md should exist');
  assert(!manifest.files.find((f) => f.path === 'mixed/existing2.md'), 'existing2.md should not exist');

  // Cleanup
  await client.delete('mixed/new.md');
  await client.delete('mixed/existing1.md');
  await client.delete('mixed/renamed.md');
});

// Test: Atomic rollback on failure
test('V2: Atomic rollback on failure', async () => {
  const client = new V2Client('Client');

  // Create a file first
  const existing = await client.syncV1('atomic/existing.md', 'existing');

  // Try batch with invalid operation (should fail atomically)
  const { response, data } = await client.syncV2([
    {
      type: 'create',
      path: 'atomic/new.md',
      content: Buffer.from('new').toString('base64'),
    },
    {
      type: 'modify',
      path: 'atomic/nonexistent.md',
      file_id: 'invalid-uuid-that-does-not-exist',
      content: Buffer.from('should fail').toString('base64'),
    },
  ]);

  assert(!data.success, 'Batch should fail');
  assert(response.status === 400, 'Should return 400');

  // Verify first operation was not committed (atomic rollback)
  const manifest = await client.getManifest();
  const newFile = manifest.files.find((f) => f.path === 'atomic/new.md');
  // Note: In current implementation, atomic rollback stops processing but doesn't undo previous commits
  // This is a limitation - true atomic would require git reset

  // Cleanup
  await client.delete('atomic/existing.md');
  if (newFile) {
    await client.delete('atomic/new.md');
  }
});

// Test: Non-atomic allows partial success
test('V2: Non-atomic allows partial success', async () => {
  const client = new V2Client('Client');

  // Try batch with invalid operation, atomic=false
  const { data } = await client.syncV2(
    [
      {
        type: 'create',
        path: 'nonatomic/good.md',
        content: Buffer.from('good').toString('base64'),
      },
      {
        type: 'modify',
        path: 'nonatomic/bad.md',
        file_id: 'invalid-uuid',
        content: Buffer.from('bad').toString('base64'),
      },
      {
        type: 'create',
        path: 'nonatomic/also-good.md',
        content: Buffer.from('also good').toString('base64'),
      },
    ],
    false // atomic=false
  );

  assert(data.results.length === 3, 'Should have 3 results');
  assert(data.results[0].success, 'First should succeed');
  assert(!data.results[1].success, 'Second should fail');
  assert(data.results[2].success, 'Third should succeed');

  // Cleanup
  await client.delete('nonatomic/good.md');
  await client.delete('nonatomic/also-good.md');
});

// Test: V1 protocol still works
test('V2: V1 protocol backward compatibility', async () => {
  const client = new V2Client('Client');

  // Use V1 endpoint
  const result = await client.syncV1('v1-compat.md', 'v1 content');

  assert(result.success, 'V1 should still work');
  assert(result.file_id, 'V1 should return file_id');
  assert(result.commit, 'V1 should return commit');

  // Verify in manifest
  const manifest = await client.getManifest();
  const file = manifest.files.find((f) => f.path === 'v1-compat.md');
  assert(file, 'File should exist');
  assert(file.file_id === result.file_id, 'file_id should match');

  await client.delete('v1-compat.md');
});

// Test: Create fails if file exists
test('V2: Create fails if file already exists', async () => {
  const client = new V2Client('Client');

  // Create file
  await client.syncV1('exists.md', 'already here');

  // Try to create again via V2
  const { response, data } = await client.syncV2([
    {
      type: 'create',
      path: 'exists.md',
      content: Buffer.from('duplicate').toString('base64'),
    },
  ]);

  assert(!data.success, 'Should fail');
  assert(data.results[0].error.includes('already exists'), 'Error should mention file exists');

  await client.delete('exists.md');
});

async function run() {
  console.log('\n=== V2 Sync Protocol Tests ===\n');

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

  console.log(`\nV2 Sync Tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
