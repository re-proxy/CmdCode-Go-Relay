#!/bin/sh
# Generate a first .env for the relay. Never overwrites an existing file.
set -eu

cd "$(dirname "$0")/.." 2>/dev/null || cd "$(dirname "$0")"

if [ -f .env ]; then
  echo ".env already exists — leaving it untouched."
  exit 0
fi

if command -v openssl >/dev/null 2>&1; then
  MASTER_KEY=$(openssl rand -base64 32)
  ADMIN_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
else
  MASTER_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')
  ADMIN_PASSWORD=$(node -e 'console.log(require("crypto").randomBytes(18).toString("base64url"))')
fi

cat > .env <<EOF
RELAY_ADMIN_PASSWORD=$ADMIN_PASSWORD
RELAY_MASTER_KEY=$MASTER_KEY
EOF

chmod 600 .env
echo "Wrote .env"
echo
echo "  admin password: $ADMIN_PASSWORD"
echo
echo "Keep this file and back it up: the master key decrypts the stored accounts."
