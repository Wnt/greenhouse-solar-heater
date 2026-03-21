FROM docker:cli

WORKDIR /config

# Copy deployment config files
COPY docker-compose.yml Caddyfile config.env ./

# Inject GITHUB_REPO at build time (from CI) so config.env is always correct
ARG GITHUB_REPO=""
RUN if [ -n "$GITHUB_REPO" ]; then \
      REPO_LC=$(echo "$GITHUB_REPO" | tr '[:upper:]' '[:lower:]'); \
      sed -i "s|^GITHUB_REPO=.*|GITHUB_REPO=$REPO_LC|" config.env; \
    fi

# Copy deploy script
COPY deploy.sh /usr/local/bin/deploy.sh
RUN chmod +x /usr/local/bin/deploy.sh

ENTRYPOINT ["deploy.sh"]
