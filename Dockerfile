# ---- Build Stage ----
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies first (cache-friendly layer ordering)
COPY package*.json ./
COPY client/package*.json client/
COPY server/package*.json server/
RUN npm ci

# Copy source and build client
COPY . .
RUN npm run build

# ---- Production Stage ----
FROM node:20-alpine
WORKDIR /app

# Copy built client and server source
COPY --from=builder /app/server ./server
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/server/package*.json ./server/

# Install production dependencies only
RUN npm ci --workspace=server --omit=dev

EXPOSE 5001

CMD ["node", "server/index.js"]
