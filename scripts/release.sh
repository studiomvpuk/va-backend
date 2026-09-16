#!/usr/bin/env sh
#
# Runs before the API starts, on every deploy.
#
# The job it really does is refuse to start a database-less API. `prisma migrate
# deploy` with an empty migrations directory prints "No migration found" and
# exits ZERO — so without this check the deploy goes green, the health check
# passes, and every single request then fails on a missing table. A boot failure
# with a clear reason is a far better afternoon than a service that is up and
# broken.
set -e

if [ ! -d prisma/migrations ] || [ -z "$(ls -A prisma/migrations 2>/dev/null)" ]; then
  echo ""
  echo "  Deploy stopped: prisma/migrations is empty."
  echo ""
  echo "  There is no schema to apply, so the API would start and then fail on"
  echo "  every query. Create the initial migration and commit it:"
  echo ""
  echo "    npx prisma migrate dev --name init"
  echo "    git add prisma/migrations && git commit && git push"
  echo ""
  exit 1
fi

echo "Applying migrations..."
npx prisma migrate deploy
