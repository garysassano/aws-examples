ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# One layer per weights file, so Lambda downloads them in parallel.
# These are the files of Qwen/Qwen3-8B-FP8; another model needs its own list.
COPY model/model-00001-of-00002.safetensors /opt/model/
COPY model/model-00002-of-00002.safetensors /opt/model/
COPY model/*.json model/*.txt /opt/model/
