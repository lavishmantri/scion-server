import {
  SyncClient,
  assert,
  assertEqual,
  computeHash,
  fileExistsInVault,
  readVaultFile,
  runTests,
} from './helpers.js';

const VAULT_NAME = 'TestVault';

const tests = {
  'Upload file via POST /vault/:name/sync': async () => {
    const client = new SyncClient('BasicClient', VAULT_NAME);
    const filePath = 'basic-test/upload.md';
    const content = 'Hello from basic test!';

    const result = await client.upload(filePath, content);

    assert(result.success, 'Upload should succeed');
    assert(result.commit, 'Upload should return a commit hash');
    assert(result.commit.length === 40, 'Commit hash should be 40 chars (SHA-1)');
    assert(result.hash === computeHash(Buffer.from(content)), 'Hash should match');

    // Cleanup
    await client.delete(filePath);
  },

  'Verify file exists in vault after upload': async () => {
    const client = new SyncClient('BasicClient', VAULT_NAME);
    const filePath = 'basic-test/vault-check.md';
    const content = 'Check vault content';

    await client.upload(filePath, content);

    assert(fileExistsInVault(VAULT_NAME, filePath), 'File should exist in vault');
    const vaultContent = readVaultFile(VAULT_NAME, filePath).toString();
    assertEqual(vaultContent, content, 'Vault content');

    // Cleanup
    await client.delete(filePath);
  },

  'Verify manifest contains uploaded file with correct hash': async () => {
    const client = new SyncClient('BasicClient', VAULT_NAME);
    const filePath = 'basic-test/manifest-check.md';
    const content = 'Manifest test content';

    await client.upload(filePath, content);

    const manifest = await client.getManifest();
    const fileRecord = manifest.files.find((f) => f.path === filePath);

    assert(fileRecord, 'File should be in manifest');
    assertEqual(fileRecord.hash, computeHash(Buffer.from(content)), 'Manifest hash');
    assert(fileRecord.commit, 'File should have a commit');
    assert(manifest.head_commit, 'Manifest should have head_commit');

    // Cleanup
    await client.delete(filePath);
  },

  'Download file via GET /vault/:name/file/:path': async () => {
    const client = new SyncClient('BasicClient', VAULT_NAME);
    const filePath = 'basic-test/download.md';
    const content = 'Download test content';

    await client.upload(filePath, content);

    // Create a new client to simulate fresh download
    const client2 = new SyncClient('BasicClient2', VAULT_NAME);
    const downloaded = await client2.download(filePath);

    assert(downloaded, 'Download should return content');
    assertEqual(downloaded.content.toString(), content, 'Downloaded content');
    assert(downloaded.commit, 'Downloaded file should have commit');

    // Cleanup
    await client.delete(filePath);
  },

  'Delete file via DELETE /vault/:name/file/:path': async () => {
    const client = new SyncClient('BasicClient', VAULT_NAME);
    const filePath = 'basic-test/delete.md';
    const content = 'Delete test content';

    await client.upload(filePath, content);
    assert(fileExistsInVault(VAULT_NAME, filePath), 'File should exist before delete');

    const result = await client.delete(filePath);
    assert(result.success, 'Delete should succeed');
    assert(!fileExistsInVault(VAULT_NAME, filePath), 'File should not exist after delete');

    // Verify not in manifest
    const manifest = await client.getManifest();
    const fileRecord = manifest.files.find((f) => f.path === filePath);
    assert(!fileRecord, 'File should not be in manifest after delete');
  },

  'Update existing file creates new commit': async () => {
    const client = new SyncClient('BasicClient', VAULT_NAME);
    const filePath = 'basic-test/update.md';

    // Upload v1
    const result1 = await client.upload(filePath, 'Version 1');
    assert(result1.commit, 'First upload should have commit');
    const commit1 = result1.commit;

    // Upload v2
    const result2 = await client.upload(filePath, 'Version 2');
    assert(result2.commit, 'Second upload should have commit');
    assert(result2.commit !== commit1, 'Second commit should be different');

    // Verify vault has v2
    const vaultContent = readVaultFile(VAULT_NAME, filePath).toString();
    assertEqual(vaultContent, 'Version 2', 'Vault should have v2');

    // Cleanup
    await client.delete(filePath);
  },

  'Status endpoint returns changes': async () => {
    const client = new SyncClient('BasicClient', VAULT_NAME);
    const filePath = 'basic-test/status.md';

    // Get initial status
    const status1 = await client.getStatus();
    const initialCommit = status1.head_commit;

    // Upload a file
    await client.upload(filePath, 'Status test content');

    // Get status with since parameter
    const status2 = await client.getStatus(initialCommit);
    assert(status2.has_changes, 'Should have changes after upload');
    assert(status2.changed_files.length > 0, 'Should list changed files');
    assert(status2.head_commit !== initialCommit, 'Head commit should be different');

    // Cleanup
    await client.delete(filePath);
  },
};

// Run tests
const success = await runTests('Basic CRUD Tests', tests);
process.exit(success ? 0 : 1);
