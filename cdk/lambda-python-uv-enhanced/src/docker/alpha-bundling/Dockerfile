# Bundling image for the official PythonFunction on python3.15, which has no SAM build image yet.
# It mirrors what the construct's own Dockerfile adds to a SAM image: a virtualenv with uv in it.
# The Lambda base image also lacks rsync, which the construct copies the project with, and its
# entrypoint would treat the bundling command as a handler name.
FROM public.ecr.aws/lambda/python:3.15-preview

ARG UV_VERSION

ENV PATH="/usr/app/venv/bin:$PATH"
ENV UV_CACHE_DIR=/tmp/uv-cache

RUN dnf install -y rsync && dnf clean all && \
    python -m venv /usr/app/venv && \
    pip install --no-cache-dir uv==${UV_VERSION} && \
    mkdir -m 777 /tmp/uv-cache

USER nobody
ENTRYPOINT []
CMD ["python"]
