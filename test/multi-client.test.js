import {
  SyncClient,
  assert,
  assertEqual,
  readVaultFile,
  runTests,
} from './helpers.js';

const VAULT_NAME = 'TestVault';

const tests = {
  'Client A uploads, Client B downloads': async () => {
    const clientA = new SyncClient('ClientA', VAULT_NAME);
    const clientB = new SyncClient('ClientB', VAULT_NAME);
    const filePath = 'multi-test/share.md';
    const content = 'Shared content from A';

    // A uploads
    await clientA.upload(filePath, content);

    // B downloads
    const downloaded = await clientB.download(filePath);

    assert(downloaded, 'B should download the file');
    assertEqual(downloaded.content.toString(), content, 'Content should match');
    assert(downloaded.commit, 'Should have a commit');

    // Both clients should have same sync state
    assertEqual(
      clientA.syncState[filePath].commit,
      clientB.syncState[filePath].commit,
      'Both clients should have same commit'
    );

    // Cleanup
    await clientA.delete(filePath);
  },

  'Three-way merge: Non-conflicting changes from A and B': async () => {
    const clientA = new SyncClient('ClientA', VAULT_NAME);
    const clientB = new SyncClient('ClientB', VAULT_NAME);
    const filePath = 'multi-test/merge.md';

    // A uploads initial version with 3 lines
    await clientA.upload(filePath, 'Line 1\nLine 2\nLine 3');

    // B syncs to get current state
    await clientB.syncFromManifest();

    // A updates line 1
    await clientA.upload(filePath, 'Line 1 - A edited\nLine 2\nLine 3');

    // B updates line 3 (has stale commit, but edits different line)
    const resultB = await clientB.upload(filePath, 'Line 1\nLine 2\nLine 3 - B edited');

    // Should auto-merge without conflict
    assert(resultB.success, 'B should succeed');
    assert(resultB.merged, 'Should be a merge');
    assert(!resultB.has_conflicts, 'Should not have conflicts (different lines)');

    // Vault should have merged content
    const vaultContent = readVaultFile(VAULT_NAME, filePath).toString();
    assert(vaultContent.includes('Line 1 - A edited'), 'Should have A\'s edit');
    assert(vaultContent.includes('Line 3 - B edited'), 'Should have B\'s edit');

    // Cleanup
    await clientA.delete(filePath);
  },

  'Three-way merge: Conflicting changes on same line': async () => {
    const clientA = new SyncClient('ClientA', VAULT_NAME);
    const clientB = new SyncClient('ClientB', VAULT_NAME);
    const filePath = 'multi-test/conflict.md';

    // A uploads initial version
    await clientA.upload(filePath, 'Original line');

    // B syncs to get current state
    await clientB.syncFromManifest();

    // A updates the same line
    await clientA.upload(filePath, 'A edited this line');

    // B updates the same line (has stale commit)
    const resultB = await clientB.upload(filePath, 'B edited this line');

    // Should have conflict markers
    assert(resultB.success, 'Upload should succeed but with conflicts');
    assert(resultB.merged, 'Should be a merge');
    assert(resultB.has_conflicts, 'Should have conflicts (same line)');
    assert(resultB.merged_content, 'Should have merged content with markers');

    // Decode and check for conflict markers
    const mergedContent = Buffer.from(resultB.merged_content, 'base64').toString();
    assert(mergedContent.includes('<<<<<<<'), 'Should have conflict start marker');
    assert(mergedContent.includes('======='), 'Should have conflict separator');
    assert(mergedContent.includes('>>>>>>>'), 'Should have conflict end marker');

    // Cleanup
    await clientA.delete(filePath);
  },

  'Client B uploads with current commit after A': async () => {
    const clientA = new SyncClient('ClientA', VAULT_NAME);
    const clientB = new SyncClient('ClientB', VAULT_NAME);
    const filePath = 'multi-test/sequential.md';

    // A uploads v1
    await clientA.upload(filePath, 'Version 1 from A');

    // B syncs from manifest to get current state
    await clientB.syncFromManifest();

    // B now has correct commit, uploads v2 (fast-forward)
    const resultB = await clientB.upload(filePath, 'Version 2 from B');

    assert(resultB.success, 'B should succeed with correct commit');
    assert(!resultB.merged, 'Should not be a merge (fast-forward)');

    // Vault should have B's content
    const vaultContent = readVaultFile(VAULT_NAME, filePath).toString();
    assertEqual(vaultContent, 'Version 2 from B', 'Vault should have B\'s content');

    // Cleanup
    await clientA.delete(filePath);
  },

  'Client A deletes, Client B uploads creates new file': async () => {
    const clientA = new SyncClient('ClientA', VAULT_NAME);
    const clientB = new SyncClient('ClientB', VAULT_NAME);
    const filePath = 'multi-test/delete-race.md';

    // A uploads
    await clientA.upload(filePath, 'Original content');

    // B syncs to get commit
    await clientB.syncFromManifest();

    // A deletes
    await clientA.delete(filePath);

    // B tries to update (file no longer exists on server)
    const resultB = await clientB.upload(filePath, 'B\'s update after delete');

    // Since file was deleted, B's upload creates a new file
    assert(resultB.success, 'B should succeed (creates new file)');
    assert(!resultB.merged, 'Should not be a merge (new file)');

    // Cleanup
    await clientB.delete(filePath);
  },

  'Multiple sequential updates from different clients': async () => {
    const clientA = new SyncClient('ClientA', VAULT_NAME);
    const clientB = new SyncClient('ClientB', VAULT_NAME);
    const clientC = new SyncClient('ClientC', VAULT_NAME);
    const filePath = 'multi-test/round-robin.md';

    // A creates file
    const result1 = await clientA.upload(filePath, 'A creates');

    // B syncs and updates
    await clientB.syncFromManifest();
    const result2 = await clientB.upload(filePath, 'B updates');

    // C syncs and updates
    await clientC.syncFromManifest();
    const result3 = await clientC.upload(filePath, 'C updates');

    // A syncs and updates
    await clientA.syncFromManifest();
    const result4 = await clientA.upload(filePath, 'A final update');

    // All should be fast-forwards (synced before each update)
    assert(!result2.merged, 'B should fast-forward');
    assert(!result3.merged, 'C should fast-forward');
    assert(!result4.merged, 'A final should fast-forward');

    // Each should have unique commits
    const commits = [result1.commit, result2.commit, result3.commit, result4.commit];
    const uniqueCommits = new Set(commits);
    assertEqual(uniqueCommits.size, 4, 'Should have 4 unique commits');

    // Verify final content
    const vaultContent = readVaultFile(VAULT_NAME, filePath).toString();
    assertEqual(vaultContent, 'A final update', 'Final content');

    // Cleanup
    await clientA.delete(filePath);
  },

  'Concurrent uploads without sync trigger merge': async () => {
    const clientA = new SyncClient('ClientA', VAULT_NAME);
    const clientB = new SyncClient('ClientB', VAULT_NAME);
    const filePath = 'multi-test/concurrent.md';

    // A uploads with multiple lines
    await clientA.upload(filePath, 'Line A\nCommon line\nLine C');

    // B gets current state
    await clientB.syncFromManifest();

    // A updates first line
    await clientA.upload(filePath, 'Line A - changed by A\nCommon line\nLine C');

    // B updates last line (has stale commit)
    const resultB = await clientB.upload(filePath, 'Line A\nCommon line\nLine C - changed by B');

    // Should auto-merge (non-conflicting lines)
    assert(resultB.merged, 'B should trigger merge');
    assert(!resultB.has_conflicts, 'Should auto-merge without conflicts');

    // Verify merged content
    const vaultContent = readVaultFile(VAULT_NAME, filePath).toString();
    assert(vaultContent.includes('changed by A'), 'Should have A\'s change');
    assert(vaultContent.includes('changed by B'), 'Should have B\'s change');

    // Cleanup
    await clientA.delete(filePath);
  },

  'First upload without base_commit (new client)': async () => {
    const client = new SyncClient('NewClient', VAULT_NAME);
    const filePath = 'multi-test/new-client.md';

    // Upload without any prior sync state (no base_commit)
    const result = await client.upload(filePath, 'New client content');

    assert(result.success, 'Should succeed');
    assert(result.commit, 'Should have commit');
    assert(!result.merged, 'Should not be a merge (new file)');

    // Cleanup
    await client.delete(filePath);
  },
};

// Run tests
const success = await runTests('Multi-Client Tests', tests);
process.exit(success ? 0 : 1);
