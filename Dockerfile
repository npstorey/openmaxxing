# Openmaxxing's chain as a Tinfoil Container: src/enclave.mjs on port 8080.
# Built by .github/workflows/build-image.yml and pinned by digest in the
# Tinfoil config repository. The image holds no key and no secret: the signing
# key is generated inside the enclave, and secrets arrive from Tinfoil at run time.
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
WORKDIR /app
ENV NODE_ENV=production HOME=/tmp NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY openmaxxing.config.json ./
COPY src ./src
COPY docs ./docs
USER node
EXPOSE 8080
CMD ["node", "src/enclave.mjs"]
