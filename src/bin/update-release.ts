export const DEFAULT_NPM_PACKAGE = 'cogmem';

export interface ResolveLatestNpmSpecOptions {
  env?: Record<string, string | undefined>;
}

export function resolveLatestNpmSpec(options: ResolveLatestNpmSpecOptions = {}): string {
  const env = options.env || {};
  // The same order `install.sh` uses, so setting two of these cannot install one
  // thing and update another. The general name wins over the npm-specific one.
  return env.COGMEM_PACKAGE_SPEC?.trim()
    || env.COGMEM_NPM_SPEC?.trim()
    || env.COGMEM_RELEASE_TARBALL?.trim()
    || 'latest';
}
