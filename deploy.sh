#!/usr/bin/env bash
set -Eeuo pipefail

echo "🚀 Building and deploying EchoWave..."

# --------------------------------------------------
# Configuration
# --------------------------------------------------
PROJECT_DIR="/home/jinu/Desktop/Sculwave Bedrock"
SERVER_DIR="/opt/minecraft-bedrock-server"
WORLD_DIR="$SERVER_DIR/worlds/Bedrock level"

BP_SOURCE="$PROJECT_DIR/BP"
RP_SOURCE="$PROJECT_DIR/RP"

BUILD_DIR="$PROJECT_DIR/build"

BP_DEV="$SERVER_DIR/development_behavior_packs/BP"
BP_WORLD="$WORLD_DIR/behavior_packs/BP"
RP_WORLD="$WORLD_DIR/resource_packs/RP"

SERVICE="minecraft-bedrock-server"
BACKUP_DIR="$PROJECT_DIR/deploy-backups/$(date +%Y%m%d-%H%M%S)"

cd "$PROJECT_DIR"

# --------------------------------------------------
# Validate project
# --------------------------------------------------
echo "🔍 Checking project files..."

[[ -f "$PROJECT_DIR/build.js" ]] || {
    echo "ERROR: build.js not found"
    exit 1
}

[[ -f "$PROJECT_DIR/config.json" ]] || {
    echo "ERROR: config.json not found"
    exit 1
}

[[ -f "$BP_SOURCE/manifest.json" ]] || {
    echo "ERROR: BP/manifest.json not found"
    exit 1
}

[[ -f "$RP_SOURCE/manifest.json" ]] || {
    echo "ERROR: RP/manifest.json not found"
    exit 1
}

[[ -d "$WORLD_DIR" ]] || {
    echo "ERROR: World directory not found: $WORLD_DIR"
    exit 1
}

command -v node >/dev/null 2>&1 || {
    echo "ERROR: Node.js is not installed"
    exit 1
}

sudo -v

# --------------------------------------------------
# Build
# --------------------------------------------------
echo "📦 Generating configuration and building project..."
node "$PROJECT_DIR/build.js"

if [[ -f "$PROJECT_DIR/tsconfig.json" ]]; then
    echo "⚙️ Compiling TypeScript..."
    npx tsc
fi

[[ -f "$BUILD_DIR/main.js" ]] || {
    echo "ERROR: build/main.js was not generated"
    exit 1
}

# Stop if the build still contains the known bad enum spelling.
if grep -R -n 'HttpRequestMethod\.POST' "$BUILD_DIR"; then
    echo "ERROR: Build still contains HttpRequestMethod.POST."
    echo "Fix the actual source file and rebuild before deploying."
    exit 1
fi

# Verify generated configuration exists.
[[ -f "$BUILD_DIR/generated/config.js" ]] || {
    echo "ERROR: build/generated/config.js was not generated"
    exit 1
}

echo "🔍 Generated configuration:"
cat "$BUILD_DIR/generated/config.js"

# --------------------------------------------------
# Prepare the complete behavior pack
# --------------------------------------------------
echo "📂 Updating BP/scripts from build output..."

mkdir -p "$BP_SOURCE/scripts"
cp -a "$BUILD_DIR/." "$BP_SOURCE/scripts/"

[[ -f "$BP_SOURCE/scripts/main.js" ]] || {
    echo "ERROR: BP/scripts/main.js missing after build"
    exit 1
}

[[ -f "$BP_SOURCE/scripts/generated/config.js" ]] || {
    echo "ERROR: Generated config missing from BP/scripts"
    exit 1
}

# --------------------------------------------------
# Back up current deployed packs
# --------------------------------------------------
echo "💾 Backing up deployed packs..."
mkdir -p "$BACKUP_DIR"

for target in "$BP_DEV" "$BP_WORLD" "$RP_WORLD"; do
    if sudo test -d "$target"; then
        name="$(basename "$(dirname "$target")")-$(basename "$target")"
        sudo cp -a "$target" "$BACKUP_DIR/$name"
    fi
done

sudo chown -R "$(id -u):$(id -g)" "$BACKUP_DIR"

# --------------------------------------------------
# Stop server
# --------------------------------------------------
SERVER_STOPPED=0

restart_server() {
    status=$?
    trap - EXIT

    if [[ "$SERVER_STOPPED" -eq 1 ]]; then
        echo "🔄 Starting Minecraft server..."
        if ! sudo systemctl start "$SERVICE"; then
            echo "ERROR: Could not start Minecraft server" >&2
            exit 1
        fi
    fi

    exit "$status"
}

trap restart_server EXIT

echo "🛑 Stopping Minecraft server..."
sudo systemctl stop "$SERVICE"
SERVER_STOPPED=1

# --------------------------------------------------
# Deploy complete packs to both behavior-pack locations
# --------------------------------------------------
echo "📦 Deploying behavior pack to development directory..."
sudo mkdir -p "$BP_DEV"
sudo cp -a "$BP_SOURCE/." "$BP_DEV/"

echo "📦 Deploying behavior pack to world directory..."
sudo mkdir -p "$BP_WORLD"
sudo cp -a "$BP_SOURCE/." "$BP_WORLD/"

echo "📦 Deploying resource pack to world directory..."
sudo mkdir -p "$RP_WORLD"
sudo cp -a "$RP_SOURCE/." "$RP_WORLD/"

# --------------------------------------------------
# Ownership
# --------------------------------------------------
echo "🔒 Setting ownership..."
sudo chown -R minecraft-bedrock:minecraft-bedrock 
    "$BP_DEV" "$BP_WORLD" "$RP_WORLD"

# --------------------------------------------------
# Verify deployment
# --------------------------------------------------
echo "🔍 Verifying deployed files..."

for target in "$BP_DEV" "$BP_WORLD"; do
    sudo test -f "$target/manifest.json"
    sudo test -f "$target/scripts/main.js"
    sudo test -f "$target/scripts/generated/config.js"

    echo "Behavior pack: $target"
    sudo grep -n 'serverUrl\|entryPointPriority' \
        "$target/scripts/generated/config.js"
done

sudo test -f "$RP_WORLD/manifest.json"

echo "Resource pack: $RP_WORLD"
echo "💾 Backups: $BACKUP_DIR"
echo "✅ Build and deployment completed."
echo "🔄 Server will restart automatically."