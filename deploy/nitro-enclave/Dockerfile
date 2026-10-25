# =============================================================================
# AWS Nitro Enclave - Verification Worker Image
# =============================================================================
# Multi-stage Dockerfile for building and running the StellarProof 
# verification worker inside an AWS Nitro Enclave with out-of-band 
# attestation bootstrap.
#
# This image:
# 1. Builds the backend with all dependencies
# 2. Includes attestation bootstrap initialization
# 3. Runs the verification worker in the secure enclave environment
# 4. Handles out-of-band attestation document generation
# =============================================================================

# Stage 1: Builder
# Build the verification worker and all dependencies in a container
FROM node:20-alpine AS builder

LABEL stage=builder
LABEL description="Build stage for StellarProof verification worker"

# Install build dependencies
RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++ \
    curl

# Install pnpm globally
RUN npm install -g pnpm@latest

# Set working directory
WORKDIR /build

# Copy workspace configuration files
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# Copy backend source
COPY backend ./backend

# Install dependencies for the entire workspace
RUN pnpm install --frozen-lockfile

# Build the backend TypeScript
WORKDIR /build/backend
RUN pnpm run build

# Copy built artifacts to output directory
RUN mkdir -p /build/dist && \
    cp -r /build/backend/dist /build/dist/backend && \
    cp -r /build/backend/node_modules /build/dist/node_modules

# =============================================================================
# Stage 2: Runtime - Nitro Enclave Image
# Production image optimized for Nitro Enclave execution
# =============================================================================
FROM node:20-alpine

LABEL maintainer="StellarProof Team"
LABEL description="StellarProof Verification Worker for AWS Nitro Enclave"
LABEL version="1.0.0"

# Security: Run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Install runtime dependencies only (no build tools)
RUN apk add --no-cache \
    dumb-init \
    curl \
    ca-certificates \
    jq

# Set working directory
WORKDIR /app

# Copy built artifacts from builder stage
COPY --from=builder --chown=nodejs:nodejs /build/dist/backend/dist ./dist/backend
COPY --from=builder --chown=nodejs:nodejs /build/dist/node_modules ./node_modules

# Copy attestation bootstrap scripts
COPY --chown=nodejs:nodejs deploy/nitro-enclave/scripts/attestation-bootstrap.sh /app/scripts/attestation-bootstrap.sh
COPY --chown=nodejs:nodejs deploy/nitro-enclave/scripts/init-enclave.sh /app/scripts/init-enclave.sh
COPY --chown=nodejs:nodejs deploy/nitro-enclave/scripts/health-check.sh /app/scripts/health-check.sh

# Copy configuration files
COPY --chown=nodejs:nodejs backend/.env.example /app/.env.example
COPY --chown=nodejs:nodejs deploy/nitro-enclave/config/nitro-config.json /app/config/nitro-config.json
COPY --chown=nodejs:nodejs deploy/nitro-enclave/config/enclave-env.example /app/config/enclave-env.example

# Make scripts executable
RUN chmod +x /app/scripts/*.sh

# Switch to non-root user
USER nodejs

# Expose monitoring port (for out-of-band communication)
EXPOSE 8081

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD /app/scripts/health-check.sh || exit 1

# Entrypoint: Initialize enclave environment and start verification worker
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Default command: Run attestation bootstrap followed by verification worker
CMD ["/bin/sh", "-c", "/app/scripts/attestation-bootstrap.sh && /app/scripts/init-enclave.sh"]
