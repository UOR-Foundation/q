// Provenance, against the real Sigstore bundles GitHub keeps for one published community holo.
// The refusals decided before any signature check run offline. Verifying a signature needs
// Sigstore's trust root, which is fetched once over the network and then cached.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { provenance, type Bundle } from '../src/provenance.ts';

const fixture = JSON.parse(await readFile(new URL('./fixtures/community-provenance.json', import.meta.url), 'utf8')) as { sha256: string; bundles: Bundle[] };
const REPOSITORY = 'UOR-Foundation/community';
const SIGNER = 'https://github.com/UOR-Foundation/community/.github/workflows/pages.yml@refs/heads/main';

test('bytes no bundle names are refused, before any signature is checked', async () => {
  await assert.rejects(provenance(fixture.bundles, '0'.repeat(64), REPOSITORY, SIGNER), /no provenance signed by .* names these bytes/);
});

test('a bundle built from another repository is refused', async () => {
  await assert.rejects(provenance(fixture.bundles, fixture.sha256, 'UOR-Foundation/website', SIGNER), /no provenance/);
});

test('verified against its signer, the newest commit that built these bytes is the pin', async () => {
  const pin = await provenance(fixture.bundles, fixture.sha256, REPOSITORY, SIGNER);
  assert.equal(pin.commit, '95566d96ca6e71721788c9f9be9eb7e0876f1ab3');
  assert.equal(pin.signedAt, '2026-11-23T18:49:52.000Z');
});

test('the same bundles are refused for any other signer', async () => {
  await assert.rejects(provenance(fixture.bundles, fixture.sha256, REPOSITORY, 'https://github.com/UOR-Foundation/community/.github/workflows/build.yml@refs/heads/main'));
});
