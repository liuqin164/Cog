import { describe, expect, test } from 'bun:test';
import { resolveLatestNpmSpec } from '../src/bin/update-release';

describe('cogmem update release resolution', () => {
  test('defaults update resolution to npm latest without network metadata', () => {
    expect(resolveLatestNpmSpec({ env: {} })).toBe('latest');
    expect(resolveLatestNpmSpec({ env: { COGMEM_NPM_SPEC: '3.6.5' } })).toBe('3.6.5');
    expect(resolveLatestNpmSpec({ env: { COGMEM_PACKAGE_SPEC: 'file:./cogmem.tgz' } })).toBe('file:./cogmem.tgz');
    // The order `install.sh` uses too: the general name beats the npm-specific one,
    // so setting both cannot install one thing and update another.
    expect(resolveLatestNpmSpec({ env: { COGMEM_PACKAGE_SPEC: '4.0.0', COGMEM_NPM_SPEC: '3.6.5', COGMEM_RELEASE_TARBALL: '5.0.0' } })).toBe('4.0.0');
    expect(resolveLatestNpmSpec({ env: { COGMEM_NPM_SPEC: '3.6.5', COGMEM_RELEASE_TARBALL: '5.0.0' } })).toBe('3.6.5');
  });

});
