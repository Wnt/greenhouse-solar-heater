FROM node:20-alpine

WORKDIR /app

# Install curl for healthcheck
RUN apk add --no-cache curl

# Copy package files and install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY poc/ ./poc/

# Make app directory owned by node user
RUN chown -R node:node /app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

ENV NODE_ENV=production
ENV PORT=3000

# Run as non-root user (node user is built into node:alpine, UID 1000)
USER node

CMD ["node", "poc/server.js"]
