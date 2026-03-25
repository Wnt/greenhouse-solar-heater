FROM node:20-alpine

WORKDIR /app

# Install curl for healthcheck
RUN apk add --no-cache curl

# Copy package files and install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY monitor/ ./monitor/

# Copy playground and its runtime dependencies (system.yaml, control logic)
COPY playground/ ./playground/
COPY system.yaml ./
COPY shelly/control-logic.js ./shelly/

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

CMD ["node", "--require", "./monitor/lib/tracing.js", "monitor/server.js"]
