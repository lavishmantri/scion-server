# ============================================
# Stage 1: Build stage
# ============================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# ============================================
# Stage 2: Production stage
# ============================================
FROM node:20-alpine AS production

# Install git (required for git merge-file command used in 3-way merges)
RUN apk add --no-cache git

# Create non-root user for security
RUN addgroup -g 1001 -S scion && \
    adduser -S scion -u 1001 -G scion

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy built artifacts from builder stage
COPY --from=builder /app/dist ./dist

# Create vault directory with proper ownership
RUN mkdir -p /data/vault && chown -R scion:scion /data /app

# Set environment defaults
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    VAULT_PATH=/home/lavishmantri/scion-vault

# Switch to non-root user
USER scion

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

# Start the server
CMD ["node", "dist/index.js"]
