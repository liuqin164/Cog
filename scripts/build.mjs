// Compile into a staging directory and swap it in only after tsc exits clean.
// `dist/` is generated and not tracked in git; a fresh checkout must run `bun run build` first.
import { cpSync, rmSync, renameSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const staging = 'dist.next'

rmSync(staging, { recursive: true, force: true })

const tsc = spawnSync(
  process.execPath,
  [
    'node_modules/typescript/bin/tsc',
    '-p',
    'tsconfig.json',
    '--outDir',
    staging,
    '--tsBuildInfoFile',
    `${staging}/.tsbuildinfo`,
  ],
  { stdio: 'inherit' },
)

if (tsc.status !== 0) {
  rmSync(staging, { recursive: true, force: true })
  console.error('build failed; the previous dist/ was left untouched')
  process.exit(tsc.status ?? 1)
}

// The companion shell ships in the same package as the kernel: `cog` is a real entry point, and a
// second package a user had to install first is the shape #287 rejected. It is compiled per file so
// `import.meta.url` keeps naming a module at the same depth it does in `shell/src`; `cogmem` stays a
// bare import resolved by the package itself, not a second copy inlined here.
const shell = spawnSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '-p', 'shell/tsconfig.build.json'],
  { stdio: 'inherit' },
)

if (shell.status !== 0) {
  rmSync(staging, { recursive: true, force: true })
  console.error('build failed; the previous dist/ was left untouched')
  process.exit(shell.status ?? 1)
}

// The observatory's page is not TypeScript, so tsc copies none of it. It is served from beside the
// compiled route module, which is why it lands at the same relative path it has in src/.
cpSync('src/observatory/web', `${staging}/observatory/web`, { recursive: true })
cpSync('shell/web-channel', `${staging}/shell/web-channel`, { recursive: true })

rmSync('dist', { recursive: true, force: true })
renameSync(staging, 'dist')
