FROM node:20-alpine

WORKDIR /app

# Install curl for healthcheck, python3 for Shelly script deploy
RUN apk add --no-cache curl python3

# Copy package files and install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy server code
COPY server/ ./server/

# Copy playground (main app) and its runtime dependencies
COPY playground/ ./playground/
COPY system.yaml ./

# Copy Shelly scripts (for simulation support and device deployment)
COPY shelly/ ./shelly/

# Make app directory owned by node user
RUN chown -R node:node /app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT
ENV NODE_ENV=production
ENV PORT=3000

# Run as non-root user (node user is built into node:alpine, UID 1000)
USER node

CMD ["node", "--require", "./server/lib/tracing.js", "server/server.js"]
