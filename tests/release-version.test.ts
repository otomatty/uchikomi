import assert from 'node:assert/strict';
import test from 'node:test';
import manifest from '../public/manifest.json';
import pkg from '../package.json';
import lock from '../package-lock.json';

test('the release has the same Chrome-compatible version in the manifest and npm metadata', () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(pkg.version, /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/);
  assert.ok(pkg.version.split('.').every(part => Number(part) <= 65535));
  assert.notEqual(pkg.version, '0.0.0');
});
