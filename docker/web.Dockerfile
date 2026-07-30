# --- Web/control-plane + dashboard builder ---
FROM node:22-bookworm-slim AS builder
WORKDIR /build
COPY control-plane/package.json control-plane/package-lock.json ./control-plane/
RUN cd control-plane && npm ci
COPY dashboard/package.json dashboard/package-lock.json ./dashboard/
RUN cd dashboard && npm ci
COPY control-plane ./control-plane
COPY dashboard ./dashboard
COPY packages ./packages
RUN cd dashboard && npm run build
RUN cd control-plane && npm run build

# --- Runtime ---
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY control-plane/package.json control-plane/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder --chown=node:node /build/control-plane/dist ./dist
COPY --from=builder --chown=node:node /build/dashboard/dist ./dashboard/dist
COPY --from=builder --chown=node:node /build/packages /packages
EXPOSE 2907
USER node
CMD ["node", "dist/index.js"]
