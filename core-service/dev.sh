#!/usr/bin/env bash
set -e

CONTAINER_NAME="octo-sandbox"
IMAGE="octo/sandbox:local"
DATA_DIR="$(pwd)/data"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Create data directory if it doesn't exist
mkdir -p "$DATA_DIR"

# Check if container exists
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    # Check if it's running
    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "Starting existing container: $CONTAINER_NAME"
        docker start "$CONTAINER_NAME"
    else
        echo "Container $CONTAINER_NAME already running"
    fi
else
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
        echo "Building sandbox image: $IMAGE"
        docker build -f "$SCRIPT_DIR/Dockerfile.sandbox" -t "$IMAGE" "$SCRIPT_DIR"
    fi

    echo "Creating container: $CONTAINER_NAME"
    docker run -d \
        --name "$CONTAINER_NAME" \
        -v "$DATA_DIR:/workspace" \
        "$IMAGE"
fi

# Run mom with tsx watch mode
echo "Starting mom in dev mode..."
npx tsx --watch-path src --watch src/main.ts --sandbox=docker:$CONTAINER_NAME ./data
