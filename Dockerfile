# ---------------------------------------------------------------------------
# PixelOffice production image (single container: server + built client).
#
# Stage 1 (build): install all workspaces, build the client (vite build) so the
# server can serve client/dist as static files.
# Stage 2 (runtime): copy node_modules + sources + client/dist, run the server
# via tsx. The server consumes @pixeloffice/shared as TS source and runs the
# server entry with tsx (matches the `npm run start -w server` dev path), so no
# separate tsc build step is needed.
#
# Static client serving is opt-in: set SERVE_CLIENT=true so Express serves the
# built client on the same port as the API + ws transport. With it unset the
# image still runs the API/ws server only (zero-config dev path is unaffected).
# ---------------------------------------------------------------------------

# ---- Stage 1: build -------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install dependencies using the lockfile for reproducible builds. Copy the
# root + each workspace manifest first to maximize layer caching.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci

# Copy the full source and build the client into client/dist.
COPY . .
RUN npm run build -w client

# ---- Stage 2: runtime -----------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Serve the built client from Express by default in the container image.
ENV SERVE_CLIENT=true
ENV PORT=2567

# Bring over installed deps + sources + the built client. (We keep dev deps
# because the server runs through tsx; for a leaner image you could compile the
# server with tsc and drop dev deps, but tsx keeps shared-as-source working.)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/client/package.json ./client/package.json
COPY --from=build /app/client/dist ./client/dist

# Run as the unprivileged node user shipped in the base image.
USER node

EXPOSE 2567

# Container healthcheck hits the REST health endpoint (never rate-limited).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||2567)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["npm", "run", "start", "-w", "server"]
