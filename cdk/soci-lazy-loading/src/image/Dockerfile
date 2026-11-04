FROM public.ecr.aws/lambda/python:3.14

# A real import workload: thousands of small files and several large shared libraries.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch

# Random bytes don't compress, so these layers cost their full size to download.
# The workload reads weights.bin and never touches unused.bin, the usual shape of a
# large image where each run needs only part of the content.
RUN mkdir -p /opt/model && head -c 256M /dev/urandom > /opt/model/weights.bin
RUN head -c 3G /dev/urandom > /opt/model/unused.bin

COPY app.py task.py ${LAMBDA_TASK_ROOT}/

CMD ["app.handler"]
