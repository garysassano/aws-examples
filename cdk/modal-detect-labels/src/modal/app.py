"""Detects objects in an image with an open model and returns what the website shows.

Deploy with `uv run modal deploy app.py` from this directory.
"""

from __future__ import annotations

import io

import modal

MODEL_ID = "PekingU/rtdetr_v2_r50vd"
# Pinned, so the weights baked into the image cannot change under a redeploy.
MODEL_REVISION = "282494075698cab9faa1096ae26856890030c817"
MIN_SCORE = 0.5
PYTORCH_CPU_INDEX = "https://download.pytorch.org/whl/cpu"


def download_model() -> None:
    """Runs while the image builds, so containers start with the weights already on disk."""
    from transformers import AutoImageProcessor, AutoModelForObjectDetection

    AutoImageProcessor.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
    AutoModelForObjectDetection.from_pretrained(MODEL_ID, revision=MODEL_REVISION)


image = (
    modal.Image.debian_slim(python_version="3.13")
    # The CPU build of PyTorch is far smaller than the default CUDA build, and this model is
    # small enough to run on a CPU.
    .uv_pip_install(
        "torch==2.14.1",
        "torchvision==0.29.1",
        index_url=PYTORCH_CPU_INDEX,
        extra_index_url="https://pypi.org/simple",
    )
    .uv_pip_install("transformers==5.21.0", "pillow==13.0.0", "fastapi==0.162.0")
    .run_function(download_model)
)

app = modal.App("detect-labels", image=image)

# Imported only where the image has them, so deploying needs nothing but the Modal client.
with image.imports():
    from fastapi import Request


@app.cls(cpu=2, memory=4096, scaledown_window=60, max_containers=3)
class Detector:
    @modal.enter()
    def load(self) -> None:
        import torch
        from transformers import AutoImageProcessor, AutoModelForObjectDetection

        self.torch = torch
        self.processor = AutoImageProcessor.from_pretrained(
            MODEL_ID, revision=MODEL_REVISION
        )
        self.model = AutoModelForObjectDetection.from_pretrained(
            MODEL_ID, revision=MODEL_REVISION
        ).eval()

    @modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
    async def detect(self, request: Request):
        """Takes the image's bytes as the request body and returns the website's result."""
        from fastapi.responses import JSONResponse
        from PIL import Image, UnidentifiedImageError

        try:
            image = Image.open(io.BytesIO(await request.body())).convert("RGB")
        except (UnidentifiedImageError, OSError):
            return JSONResponse({"status": "unsupported"}, status_code=415)

        inputs = self.processor(images=image, return_tensors="pt")
        with self.torch.no_grad():
            outputs = self.model(**inputs)
        detections = self.processor.post_process_object_detection(
            outputs,
            target_sizes=self.torch.tensor([(image.height, image.width)]),
            threshold=MIN_SCORE,
        )[0]

        id2label = self.model.config.id2label
        best: dict[str, float] = {}
        boxes = []
        for score, label_id, box in zip(
            detections["scores"], detections["labels"], detections["boxes"]
        ):
            name, score = id2label[label_id.item()], score.item()
            best[name] = max(best.get(name, 0.0), score)
            if name == "cat":
                left, top, right, bottom = box.tolist()
                boxes.append(
                    {
                        "left": max(left, 0) / image.width,
                        "top": max(top, 0) / image.height,
                        "width": (min(right, image.width) - max(left, 0)) / image.width,
                        "height": (min(bottom, image.height) - max(top, 0))
                        / image.height,
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
