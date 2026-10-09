# Build stage: pnpm's official image, with Node pinned to the runtime's major.
FROM ghcr.io/pnpm/pnpm:12 AS build
RUN pnpm runtime set node 24 -g
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/var/cache/pnpm \
    pnpm install --store-dir /var/cache/pnpm --frozen-lockfile
COPY . .
# Bundles the server and its dependencies into dist/index.mjs.
RUN pnpm build

# Runtime stage: Node plus the Lambda Web Adapter extension, no node_modules.
FROM public.ecr.aws/docker/library/node:24-slim
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 /lambda-adapter /opt/extensions/lambda-adapter
WORKDIR /app
COPY --from=build /app/dist/index.mjs ./

ENV AWS_LWA_PORT="3000"
ENV AWS_LWA_READINESS_CHECK_PATH="/ping"

USER node
EXPOSE 3000
CMD ["node", "index.mjs"]
