# Model container

The SageMaker detector's inference server: [D-FINE-L](https://huggingface.co/ustc-community/dfine-large-coco), an Apache-2.0 COCO object detector with 31M parameters, behind a small HTTP server for SageMaker.

- `serve.py` answers SageMaker's `GET /ping` and `POST /invocations` on port 8080. An invocation names the image in S3, `{"bucket": "...", "key": "uploads/..."}`, because Serverless Inference caps requests at 4 MB and uploads can be 15 MB.
- Each image is turned upright by its EXIF orientation, as the browser shows it, and large JPEGs are decoded at reduced scale, since the model sees 640×640 pixels. Objects below a score of 0.5 are dropped, and each `cat` gets a bounding box.
- The Dockerfile installs the CPU build of PyTorch with uv and bakes in the weights at a pinned commit, so a container downloads nothing when it starts. The image is about 0.5 GB compressed in ECR.
- The endpoint has 6 GB of memory, the most Serverless Inference offers, which also gives the most vCPUs, and at most 5 concurrent requests. Provisioned concurrency would remove the wait for a new container after the endpoint was idle, but is billed while idle.

## Choosing the model

Every model was run over 51 photos on 4 CPU threads: 33 cats, 17 other animals including lynxes, tigers, a cheetah, foxes, a raccoon, and dogs, and a European wildcat left out of the counts.

| Model                                                                                            | Cats found, of 33 | Other animals called a cat, of 17 | Time per image |
| ------------------------------------------------------------------------------------------------ | ----------------- | --------------------------------- | -------------- |
| [D-FINE-L, COCO](https://huggingface.co/ustc-community/dfine-large-coco)                         | 32                | 10                                | 345 ms         |
| [D-FINE-L, Objects365 then COCO](https://huggingface.co/ustc-community/dfine-large-obj2coco-e25) | 31                | 9                                 | 328 ms         |
| [D-FINE-X, Objects365 then COCO](https://huggingface.co/ustc-community/dfine-xlarge-obj2coco)    | 31                | 8                                 | 632 ms         |
| [D-FINE-L, Objects365](https://huggingface.co/ustc-community/dfine-large-obj365)                 | 31                | 8                                 | 375 ms         |
| [RF-DETR-L](https://huggingface.co/Roboflow/rf-detr-large)                                       | 29                | 7                                 | 463 ms         |

None found more cats than D-FINE-L on COCO. The animals they call a cat are mostly wild felines, which COCO has no class for.
