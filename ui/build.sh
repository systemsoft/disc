#!/bin/bash

# Build script for Disc UI

echo "🎨 Building Disc Admin UI..."

# Check if npm is installed
if ! command -v bun &> /dev/null; then
  echo "❌ bun is not installed. Please install bun."
  exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  bun install
fi

# Build the UI
echo "🔨 Building UI..."
bun run build

if [ $? -eq 0 ]; then
  echo "✅ UI built successfully!"
  echo "📁 Build output: $(pwd)/build"
else
  echo "❌ Build failed"
  exit 1
fi
