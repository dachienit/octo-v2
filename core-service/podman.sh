#!/usr/bin/env bash

# Mom Podman Sandbox Management Script
# Usage:
#   ./podman.sh create <data-dir>   - Create and start the container
#   ./podman.sh build               - Build the sandbox image
#   ./podman.sh start               - Start the container
#   ./podman.sh stop                - Stop the container
#   ./podman.sh remove              - Remove the container
#   ./podman.sh status              - Check container status
#   ./podman.sh shell               - Open a shell in the container

CONTAINER_NAME="octo-sandbox"
IMAGE="octo/sandbox:local"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

build_image() {
    echo "Building sandbox image '${IMAGE}' with Podman..."
    podman build -f "${SCRIPT_DIR}/Dockerfile.sandbox" -t "${IMAGE}" "${SCRIPT_DIR}"
}

case "$1" in
  build)
    build_image
    ;;

  create)
    if [ -z "$2" ]; then
      echo "Usage: $0 create <data-dir>"
      echo "Example: $0 create ./data"
      exit 1
    fi

    DATA_DIR=$(cd "$2" && pwd)

    if podman ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "Container '${CONTAINER_NAME}' already exists. Remove it first with: $0 remove"
      exit 1
    fi

    if ! podman image inspect "$IMAGE" >/dev/null 2>&1; then
      build_image
    fi

    echo "Creating container '${CONTAINER_NAME}'..."
    echo "  Data dir: ${DATA_DIR} -> /workspace"

    podman run -d \
      --name "$CONTAINER_NAME" \
      -v "${DATA_DIR}:/workspace" \
      "$IMAGE"

    if [ $? -eq 0 ]; then
      echo "Container created and running."
      echo ""
      echo "Run mom with: mom --sandbox=podman:${CONTAINER_NAME} $2"
    else
      echo "Failed to create container."
      exit 1
    fi
    ;;

  start)
    echo "Starting container '${CONTAINER_NAME}'..."
    podman start "$CONTAINER_NAME"
    ;;

  stop)
    echo "Stopping container '${CONTAINER_NAME}'..."
    podman stop "$CONTAINER_NAME"
    ;;

  remove)
    echo "Removing container '${CONTAINER_NAME}'..."
    podman rm -f "$CONTAINER_NAME"
    ;;

  status)
    if podman ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "Container '${CONTAINER_NAME}' is running."
      podman ps --filter "name=${CONTAINER_NAME}" --format "table {{.ID}}\t{{.Image}}\t{{.Status}}"
    elif podman ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "Container '${CONTAINER_NAME}' exists but is not running."
      echo "Start it with: $0 start"
    else
      echo "Container '${CONTAINER_NAME}' does not exist."
      echo "Create it with: $0 create <data-dir>"
    fi
    ;;

  shell)
    echo "Opening shell in '${CONTAINER_NAME}'..."
    podman exec -it "$CONTAINER_NAME" /bin/sh
    ;;

  *)
    echo "Mom Podman Sandbox Management"
    echo ""
    echo "Usage: $0 <command> [args]"
    echo ""
    echo "Commands:"
    echo "  build              - Build the sandbox image"
    echo "  create <data-dir>  - Create and start the container"
    echo "  start              - Start the container"
    echo "  stop               - Stop the container"
    echo "  remove             - Remove the container"
    echo "  status             - Check container status"
    echo "  shell              - Open shell in the container"
    ;;
esac
