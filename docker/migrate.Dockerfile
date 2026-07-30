# --- Control-plane migration builder ---
FROM node:22-bookworm-slim AS builder
WORKDIR /build
COPY control-plane/package.json control-plane/package-lock.json ./control-plane/
RUN cd control-plane && npm ci
COPY control-plane ./control-plane
RUN cd control-plane && npm run build

# --- One-shot migration runner ---
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY control-plane/package.json control-plane/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder --chown=node:node /build/control-plane/dist ./dist
COPY --chown=node:node migrations /migrations
COPY packages /packages
USER node
CMD ["node", "dist/migrate.js"]
