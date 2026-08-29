#!/bin/bash

set -e

IMAGE="djdiptayan/pixeloffice:latest"
CONTAINER_NAME="pixeloffice-app"
ENV_FILE=".env.pixeloffice"
HOST_PORT="127.0.0.1:2567"
CONTAINER_PORT="2567"

echo "Pulling latest image..."
docker pull "$IMAGE"

echo "Stopping existing container (if any)..."
docker stop "$CONTAINER_NAME" 2>/dev/null || true
docker rm "$CONTAINER_NAME" 2>/dev/null || true

echo "Starting new container..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  "$IMAGE"

echo "Container restarted successfully."
