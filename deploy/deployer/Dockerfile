FROM docker:cli

WORKDIR /config

# Copy deployment config files
COPY docker-compose.yml Caddyfile ./

# Copy deploy script
COPY deploy.sh /usr/local/bin/deploy.sh
RUN chmod +x /usr/local/bin/deploy.sh

ENTRYPOINT ["deploy.sh"]
