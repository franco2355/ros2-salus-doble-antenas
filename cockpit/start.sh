#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

# Liberar puertos si ya están ocupados
for PORT in 5173 7681; do
  PIDS=$(lsof -t -i:$PORT 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "Liberando puerto $PORT (PID $PIDS)..."
    kill $PIDS 2>/dev/null || true
    sleep 0.3
  fi
done

echo "Iniciando PTY server..."
node pty-server.js &
PTY_PID=$!

echo "Iniciando Vite dev server..."
npm run dev &
VITE_PID=$!

trap 'kill $PTY_PID $VITE_PID 2>/dev/null; exit' INT TERM EXIT

wait
