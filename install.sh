#!/usr/bin/env bash
# The Cog installer.
#
# It installs the package, links the CLI and stops. It never runs setup and never
# writes config: installation is `cogmem install`, verification is `cogmem doctor`.
# See ADR-0003.
set -euo pipefail

INSTALL_HOME="${COGMEM_INSTALL_HOME:-$HOME/.cogmem/pkg}"
BIN_DIR="${COGMEM_BIN_DIR:-$HOME/.bun/bin}"
# The most general name wins, then the npm-specific one, then the tarball. One
# implementation, so setting two of these cannot install one thing and update another.
PACKAGE_SPEC="${COGMEM_PACKAGE_SPEC:-${COGMEM_NPM_SPEC:-${COGMEM_RELEASE_TARBALL:-latest}}}"

log() {
  printf 'cogmem: %s\n' "$*"
}

platform_guard() {
  case "$(uname -s)" in
    Linux) ;;
    Darwin)
      log "macOS is not supported by Cogmem 5.0. Nothing was installed."
      log "Supported platform: Linux (systemd user service)."
      exit 1
      ;;
    *)
      log "Unsupported platform: $(uname -s). Cogmem 5.0 supports Linux only. Nothing was installed."
      exit 1
      ;;
  esac
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

ensure_bun() {
  if need_cmd bun; then
    return
  fi

  log "Bun was not found; installing Bun for the current user."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if ! need_cmd bun; then
    log "Bun install finished but bun is still not on PATH."
    log "Add $HOME/.bun/bin to PATH and rerun this installer."
    exit 1
  fi
}

ensure_install_home() {
  mkdir -p "$INSTALL_HOME"
  if [ ! -f "$INSTALL_HOME/package.json" ]; then
    printf '{"private":true,"dependencies":{}}\n' > "$INSTALL_HOME/package.json"
  fi
}

# Install one package spec.
#
# A registry spec is a version, so the name is added: `cogmem@latest`. A tarball,
# a directory or a URL is already a package location, and prefixing it produces
# `cogmem@/path/to/cogmem-4.0.0.tgz`, which npm and bun both reject — which is why
# `COGMEM_RELEASE_TARBALL` and a local install had no working path. Registry specs
# keep the name so no other package can be installed by accident.
install_package() {
  local spec="$1"
  case "$spec" in
    # Any spec carrying a scheme is a location too: `npm:`, `file:`, `http:`,
    # `https:`, `github:`, `git+ssh:`. A version range never contains a colon, so
    # this cannot swallow one. `*` stays in the registry branch, where `cogmem@*` is
    # a valid range.
    *:* | /* | ./* | ../* | *.tgz | *.tar.gz)
      install_from_location "$spec"
      ;;
    *)
      bun add --omit=optional "cogmem@$spec"
      ;;
  esac
}

# A location is not always a built package.
#
# A git spec is source: this package declares `prepare`, but bun does not install a
# git dependency's devDependencies before running it, so the build finds no `tsc`,
# fails, and bun rolls the whole install back — installing from GitHub did not work
# at all. Install with scripts off, build the package where it landed, then relink,
# because the bins cannot be linked while their target does not exist yet.
install_from_location() {
  local spec="$1"
  bun add --omit=optional --ignore-scripts "$spec"
  if [ -x "$INSTALL_HOME/node_modules/.bin/cogmem" ]; then
    return
  fi

  local built=0
  local dir
  for dir in "$INSTALL_HOME"/node_modules/*/; do
    [ -f "$dir/package.json" ] || continue
    [ -e "${dir}dist" ] && continue
    grep -q '"prepare"[[:space:]]*:' "$dir/package.json" || continue
    log "Building the source package at ${dir%/}."
    if ! ( cd "$dir" && bun install --omit=optional && bun run prepare ); then
      log "Building ${dir%/} failed, so no CLI was created."
      exit 1
    fi
    built=1
  done
  [ "$built" = "1" ] || return 0
  ( cd "$INSTALL_HOME" && bun install --omit=optional )
}

link_cli() {
  mkdir -p "$BIN_DIR"
  local package_json="$INSTALL_HOME/node_modules/cogmem/package.json"
  if [ ! -f "$package_json" ]; then
    log "Installed package has no package.json at $package_json."
    exit 1
  fi
  # Link what the package declares, not a name pattern: 5.0 declares `cog` and `cogmem`, while
  # older releases declare `cogmem` and `cogmem-mcp`. A glob over `cogmem*` silently missed `cog`.
  local names
  if ! names=$(bun -e 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (!p.bin || typeof p.bin !== "object") process.exit(2); process.stdout.write(Object.keys(p.bin).join(" "));' "$package_json"); then
    log "Installed package at $package_json declares no bins."
    exit 1
  fi
  if [ -z "$names" ]; then
    log "Installed package at $package_json declares no bins."
    exit 1
  fi
  local linked=()
  local name
  for name in $names; do
    local target="$INSTALL_HOME/node_modules/.bin/$name"
    if [ ! -x "$target" ]; then
      log "Installed package declares $name but did not create $target."
      exit 1
    fi
    ln -sf "$target" "$BIN_DIR/$name"
    linked+=("$BIN_DIR/$name")
  done
  log "Installed CLIs: ${linked[*]}"
}

on_path() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Print the two Install paths and the gate.
#
# The step list lives in the CLI, not here: the installer asks the install gate
# rather than keeping a second copy of the wording. The fallback only runs when
# the freshly installed CLI cannot start, which is itself a broken install.
print_next_steps() {
  local cli="$BIN_DIR/cogmem"

  if ! on_path "$BIN_DIR"; then
    log "Warning: $BIN_DIR is not on PATH, so 'cogmem' will not resolve yet."
    log "  Fix it for this shell:  export PATH=\"$BIN_DIR:\$PATH\""
    log "  Or call the CLI by absolute path:  $cli"
    log "  The install gate reports this as a WARN, not a failure."
    printf '\n'
  fi

  printf '\n'
  if "$cli" doctor; then
    return
  fi

  log "The installed CLI did not start, so its step list could not be printed."
  log "Try:  $cli doctor"
  printf '\n'
  log "Cog is installed. Setup is a separate step; run the CLI to see its steps:"
  log "  $cli doctor"
  printf '\n'
}

main() {
  platform_guard
  ensure_bun
  ensure_install_home

  log "Installing cogmem@$PACKAGE_SPEC from npm-compatible package resolution."
  (
    cd "$INSTALL_HOME"
    install_package "$PACKAGE_SPEC"
  )
  link_cli

  log "Installed package home: $INSTALL_HOME"
  print_next_steps
}

main "$@"
