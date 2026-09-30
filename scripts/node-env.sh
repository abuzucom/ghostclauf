# shellcheck shell=sh
# Sourced by setup.sh and run.sh. Not executable on its own.
#
# Provides a Node.js that satisfies package.json "engines" without touching
# the system install. A private copy lives in $HOME/.ghostclauf/node and is
# put first on PATH, so it wins over an older system Node.

NODE_LTS_LINE="v24.x"
NODE_DIST_URL="https://nodejs.org/dist/latest-$NODE_LTS_LINE"
GHOSTCLAUF_NODE_HOME="$HOME/.ghostclauf/node"

# Prefer the private copy when present.
if [ -d "$GHOSTCLAUF_NODE_HOME/bin" ]; then
    PATH="$GHOSTCLAUF_NODE_HOME/bin:$PATH"
    export PATH
fi

# Succeed when node and npm exist and node is 22.22.0 or newer.
node_is_supported() {
    command -v node >/dev/null 2>&1 || return 1
    command -v npm >/dev/null 2>&1 || return 1
    node -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > 22 || (a === 22 && b >= 22) ? 0 : 1)" >/dev/null 2>&1
}

# Print the nodejs.org platform tag for this machine, or nothing if unsupported.
node_platform_tag() {
    case "$(uname -s)" in
        Linux) os="linux" ;;
        Darwin) os="darwin" ;;
        *) return 1 ;;
    esac
    case "$(uname -m)" in
        x86_64 | amd64) arch="x64" ;;
        aarch64 | arm64) arch="arm64" ;;
        *) return 1 ;;
    esac
    echo "$os-$arch"
}

# Print the SHA-256 of a file using whichever tool the platform ships.
file_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d ' ' -f 1
    else
        shasum -a 256 "$1" | cut -d ' ' -f 1
    fi
}

# Download the newest Node 24 LTS tarball, verify it against the published
# SHASUMS256.txt, and unpack it into GHOSTCLAUF_NODE_HOME.
install_private_node() {
    if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
        echo "curl and tar are required to install Node.js automatically."
        return 1
    fi

    tag="$(node_platform_tag)" || {
        echo "No automatic Node.js install for this platform. Install Node.js 22.22 or newer from https://nodejs.org/."
        return 1
    }

    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT

    echo "Looking up the latest Node.js $NODE_LTS_LINE release..."
    curl -fsSL "$NODE_DIST_URL/SHASUMS256.txt" -o "$work/SHASUMS256.txt" || return 1
    tarball="$(grep "node-v[0-9.]*-$tag.tar.gz\$" "$work/SHASUMS256.txt" | awk '{print $2}' | head -n 1)"
    if [ -z "$tarball" ]; then
        echo "No Node.js build found for $tag."
        return 1
    fi

    echo "Downloading $tarball..."
    curl -fsSL "$NODE_DIST_URL/$tarball" -o "$work/$tarball" || return 1

    expected="$(grep " $tarball\$" "$work/SHASUMS256.txt" | cut -d ' ' -f 1)"
    actual="$(file_sha256 "$work/$tarball")"
    if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
        echo "Checksum mismatch for $tarball. Refusing to install it."
        return 1
    fi

    mkdir -p "$work/unpacked"
    tar -xzf "$work/$tarball" -C "$work/unpacked" || return 1
    rm -rf "$GHOSTCLAUF_NODE_HOME"
    mkdir -p "$(dirname "$GHOSTCLAUF_NODE_HOME")"
    mv "$work/unpacked/${tarball%.tar.gz}" "$GHOSTCLAUF_NODE_HOME" || return 1

    PATH="$GHOSTCLAUF_NODE_HOME/bin:$PATH"
    export PATH
}

# Install a private Node.js when the current one is missing or too old.
ensure_node() {
    if node_is_supported; then
        return 0
    fi
    echo "Node.js 22.22 or newer is required. Installing the latest Node.js 24 LTS to $GHOSTCLAUF_NODE_HOME..."
    install_private_node || return 1
    node_is_supported
}
