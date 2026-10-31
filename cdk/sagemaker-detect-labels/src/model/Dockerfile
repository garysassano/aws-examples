# Serverless Inference runs x86_64 containers of up to 10 GB; this image is about 1.5 GB.
FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /bin/uv

WORKDIR /opt/program
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project --no-cache

# Bake the weights into the image at a pinned revision, so a container never downloads them and a
# rebuild cannot change them.
ENV MODEL_DIR=/opt/model
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('ustc-community/dfine-large-coco', revision='aa8f8211545e4cff5adf52ea512f9ac74a9824ec', local_dir='/opt/model')"
ENV HF_HUB_OFFLINE=1

COPY serve.py ./

# SageMaker passes `serve` as the only argument, which the server ignores.
ENTRYPOINT ["python", "serve.py"]
