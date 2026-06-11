#!/bin/bash

set -e

IMAGE="djdiptayan/pixeloffice:latest"
CONTAINER_NAME="pixeloffice"

echo "Pulling latest image..."
docker pull $IMAGE

echo "Stopping existing container (if any)..."
docker stop $CONTAINER_NAME 2>/dev/null || true
docker rm $CONTAINER_NAME 2>/dev/null || true

echo "Starting new container..."
docker run -d \
  --name $CONTAINER_NAME \
  --env-file xyz.env \
  -p 2567:2576 \
  $IMAGE

echo "Container restarted successfully."