#!/usr/bin/env bun
import { loadUpdateSettings, refreshUpdateCache } from '../install/VersionCheck.js';

/**
 * The detached half of the version check (#150).
 *
 * `cogmem` starts this and does not wait for it, and so does the resident observatory when it
 * is launched directly. Everything that
 * could take time — the registry read — happens here, out of the caller's way.
 *
 * It writes nothing to stdout or stderr. Its result is the cache file. A check
 * that fails is a check that says nothing, which is the ticket's requirement and
 * also the only behaviour that cannot corrupt a host's JSON-RPC stream.
 */
async function main(): Promise<void> {
  const settings = loadUpdateSettings({});
  if (!settings.check) return;
  await refreshUpdateCache({});
}

main().catch(() => {
  // Silent by contract: nothing here is worth a line on a command that succeeded.
});
