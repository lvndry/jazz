# Builds the disposable environment for Pre Release Review. Only the repository and review
# data are mounted at runtime; GitHub credentials and runner control files stay on the host.
# Validation uses a fresh container from this image without the model credential or review data.
FROM oven/bun:1.4.2 AS bun
FROM node:22-bookworm-slim

USER root
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/local/bin/bun /usr/local/bin/bunx
ENV PATH="/root/.bun/bin:${PATH}"
RUN bun install -g jazz-ai@latest --trust
WORKDIR /workspace
