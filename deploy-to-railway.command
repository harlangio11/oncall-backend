#!/bin/bash
# OnCall Backend — Deploy to Railway
# Double-click this file to upload the backend code to Railway.

set -e
cd "$(dirname "$0")"

echo ""
echo "🚀 Deploying OnCall backend to Railway..."
echo ""

export RAILWAY_TOKEN=1371fa97-747a-44f9-a618-263fc5163712
export RAILWAY_PROJECT_ID=e64c9b28-0b5d-409a-b4c9-0c9b6ceaeccd
export RAILWAY_SERVICE_ID=2070487f-5eb0-47cd-a9fe-566b152f69b2
export RAILWAY_ENVIRONMENT_ID=2559b708-2288-4927-98f7-e745cd5b2262

echo "⬆️  Uploading code..."
npx --yes @railway/cli@latest up --service 2070487f-5eb0-47cd-a9fe-566b152f69b2 2>&1 | grep -v "npm warn"

echo ""
echo "✅ Done! Your backend is live at:"
echo "   https://scintillating-ambition-production-e638.up.railway.app"
echo ""
echo "Health check: https://scintillating-ambition-production-e638.up.railway.app/health"
echo ""
read -p "Press Enter to close..."
