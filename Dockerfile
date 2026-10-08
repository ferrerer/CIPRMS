# Debian-based "slim" image, not alpine: bcrypt and sharp ship prebuilt
# binaries for glibc, not musl, so alpine would force a slower from-source
# node-gyp rebuild (and still risks missing libs) for both.
FROM node:20-bullseye-slim AS base
WORKDIR /app

# Only copy manifests first so `npm ci` is cached as its own layer and only
# re-runs when dependencies actually change, not on every source edit.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Must exist before the app's first write — the app does create it at
# runtime (middleware/uploadMiddleware.js), but that race is avoided here.
RUN mkdir -p uploads/tmp uploads/documents uploads/avatars

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "cirl.js"]
