#!/bin/bash
cd "$(dirname "$0")"
export RAILWAY_TOKEN=f947ca61-c575-4756-89bd-7246f9063da7

echo "=== Testing Railway CLI ==="
echo ""
echo "Railway version:"
npx --yes @railway/cli@latest --version 2>&1

echo ""
echo "Railway whoami:"
npx --yes @railway/cli@latest whoami 2>&1

echo ""
echo "Railway status:"
npx --yes @railway/cli@latest status 2>&1

read -p "Press Enter to close..."
