#!/bin/bash
# OnCall Backend — Push to GitHub (triggers Railway auto-deploy)
# Double-click this file to commit and push backend changes.
# On first run you'll be asked for your GitHub Personal Access Token.
# It gets stored in macOS Keychain — you'll never be asked again.

cd "$(dirname "$0")"

echo ""
echo "📦 Pushing OnCall backend to GitHub..."
echo ""

# Store credentials in macOS Keychain via osxkeychain helper
git config credential.helper osxkeychain

# Add GitHub remote if not already set
if ! git remote get-url origin 2>/dev/null; then
  echo "🔗 Adding GitHub remote..."
  git remote add origin https://github.com/harlangio11/oncall-backend.git
fi

# Make sure remote uses HTTPS (not SSH)
git remote set-url origin https://github.com/harlangio11/oncall-backend.git

# Stage all backend changes
git add -A
git status

# Commit (skip if nothing new)
echo ""
echo "💾 Committing changes..."
git commit -m "Multi-user backend: VoIP push, Apple Sign-In, per-user Twilio, Gmail" 2>/dev/null \
  && echo "   ✅ Committed" \
  || echo "   ℹ️  Already committed — pushing existing commit"

# Push
echo ""
echo "🚀 Pushing to GitHub → Railway will auto-deploy in ~30s..."
echo "   (First time: enter your GitHub username, then your Personal Access Token as the password)"
echo "   Generate a token at: https://github.com/settings/tokens/new?scopes=repo&description=oncall-deploy"
echo ""
git push origin master:main 2>&1 || git push origin master 2>&1

echo ""
echo "✅ Done! Railway is deploying. Watch here:"
echo "   https://railway.com/project/e64c9b28-0b5d-409a-b4c9-0c9b6ceaeccd/service/2070487f-5eb0-47cd-a9fe-566b152f69b2"
echo ""
read -p "Press Enter to close..."
