"""SageMaker inference server: detects objects in an image from S3 with D-FINE-L.

SageMaker starts the container with the argument `serve` and sends `GET /ping` and
`POST /invocations` to port 8080. Each invocation is a JSON object naming the image in S3, such as
`{"bucket": "...", "key": "uploads/..."}`, because Serverless Inference caps request payloads at
4 MB and uploads can be 15 MB. The response is the result the website shows.
"""

import io
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import boto3
import torch
from PIL import Image, UnidentifiedImageError
from transformers import AutoImageProcessor, AutoModelForObjectDetection

# Baked into the image by the Dockerfile, so containers start without downloading anything.
MODEL_DIR = os.environ.get("MODEL_DIR", "/opt/model")
MIN_SCORE = 0.5

torch.set_num_threads(os.cpu_count() or 1)
processor = AutoImageProcessor.from_pretrained(MODEL_DIR)
model = AutoModelForObjectDetection.from_pretrained(MODEL_DIR).eval()
s3 = boto3.client("s3")
# Serverless Inference sends one request at a time to a container; the lock keeps it that way if
# a real-time endpoint ever sends more.
inference_lock = threading.Lock()


def detect(image: Image.Image) -> dict:
    """Returns the labels above MIN_SCORE, and a box for each cat as ratios of the image size."""
    with inference_lock, torch.inference_mode():
        inputs = processor(images=image, return_tensors="pt")
        outputs = model(**inputs)
        detections = processor.post_process_object_detection(
            outputs,
            target_sizes=torch.tensor([(image.height, image.width)]),
            threshold=MIN_SCORE,
        )[0]

    best: dict[str, float] = {}
    boxes = []
    for score, label_id, box in zip(
        detections["scores"], detections["labels"], detections["boxes"]
    ):
        name, score = model.config.id2label[label_id.item()], score.item()
        best[name] = max(best.get(name, 0.0), score)
        if name == "cat":
            left, top = max(box[0].item(), 0), max(box[1].item(), 0)
            right = min(box[2].item(), image.width)
            bottom = min(box[3].item(), image.height)
            boxes.append(
                {
                    "left": left / image.width,
                    "top": top / image.height,
                    "width": (right - left) / image.width,
                    "height": (bottom - top) / image.height,
                }
            )

    return {
        "status": "done",
        "isCat": "cat" in best,
        "confidence": round(best["cat"] * 100, 1) if "cat" in best else None,
        "labels": [
            {"name": name, "confidence": round(score * 100, 1)}
            for name, score in sorted(best.items(), key=lambda item: -item[1])
        ],
        "boxes": boxes,
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/ping":
            self.reply(200, {})
        else:
            self.reply(404, {"message": "not found"})

    def do_POST(self) -> None:
        if self.path != "/invocations":
            return self.reply(404, {"message": "not found"})
        try:
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            bucket, key = request["bucket"], request["key"]
        except (KeyError, TypeError, ValueError):
            return self.reply(400, {"message": 'Send {"bucket": ..., "key": ...}'})

        body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
        try:
            image = Image.open(io.BytesIO(body)).convert("RGB")
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
            # A file that is not an image would fail on every retry, so it is a result, not an
            # error.
            return self.reply(200, {"status": "unsupported"})
        self.reply(200, detect(image))

    def reply(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args) -> None:
        # Keep the health checks out of the endpoint's logs.
        if self.path != "/ping":
            super().log_message(format, *args)


if __name__ == "__main__":
    print(f"Model loaded from {MODEL_DIR}; serving on port 8080", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
