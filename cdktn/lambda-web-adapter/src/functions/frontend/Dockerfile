# Build stage: pnpm's official image, with Node pinned to the runtime's major.
FROM ghcr.io/pnpm/pnpm:12 AS build
RUN pnpm runtime set node 24 -g
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/var/cache/pnpm \
    pnpm install --store-dir /var/cache/pnpm --frozen-lockfile
COPY . .
# adapter-node bundles every devDependency, so build/ runs without node_modules.
RUN pnpm build

# Runtime stage: Node plus the Lambda Web Adapter extension, no node_modules.
FROM public.ecr.aws/docker/library/node:24-slim
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 /lambda-adapter /opt/extensions/lambda-adapter
WORKDIR /app
# package.json marks build/ as ES modules.
COPY --from=build /app/package.json ./
COPY --from=build /app/build ./build

ENV AWS_LWA_PORT="3000"
ENV AWS_LWA_READINESS_CHECK_PATH="/ping"

USER node
EXPOSE 3000
CMD ["node", "build"]
