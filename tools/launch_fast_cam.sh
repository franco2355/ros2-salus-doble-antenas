#!/usr/bin/env bash
set -euo pipefail

CAMERA_HOST="${CAMERA_HOST:-192.168.1.64}"
CAMERA_USER="${CAMERA_USER:-admin}"
CAMERA_PASS="${CAMERA_PASS:-teamcit2024}"
FETCH_THREADS="${FETCH_THREADS:-1}"
HTTP_PORT="${HTTP_PORT:-8089}"
TARGET_FPS="${TARGET_FPS:-1}"

echo "[fast-cam] stream en http://localhost:${HTTP_PORT}/"

CAMERA_HOST="$CAMERA_HOST" \
CAMERA_USER="$CAMERA_USER" \
CAMERA_PASS="$CAMERA_PASS" \
FETCH_THREADS="$FETCH_THREADS" \
HTTP_PORT="$HTTP_PORT" \
TARGET_FPS="$TARGET_FPS" \
python3 "$(dirname "$0")/fast_mjpeg_server.py"
