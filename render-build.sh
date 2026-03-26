#!/usr/bin/env bash
# Build script for Render deployment
# Installs backend dependencies and builds the React frontend

set -e

echo "=== Installing Python dependencies ==="
pip install -r backend/requirements.txt

echo "=== Installing Node.js dependencies ==="
cd frontend
npm install

echo "=== Building React frontend ==="
npm run build
cd ..

echo "=== Build complete ==="
