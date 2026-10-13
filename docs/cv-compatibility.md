# Local computer-vision compatibility

This note covers the installed Windows Python application. Model loading and webcam inference run on that machine. The Cloudflare showcase remains browser-only and does not load models or send frames to cloud inference.

## Shared OpenCV dependency

Keep one `cv2` distribution in the Python environment. The project, Ultralytics, and InsightFace all use the `cv2` namespace. Current InsightFace and Ultralytics packages declare `opencv-python`; using `opencv-python>=4.10,<5` as the base dependency lets optional extras share it. The OpenCV project warns against installing multiple variants together. `opencv-python-headless` omits GUI functions such as `cv2.imshow`; it is suited to no-display services, not needed for this installed webcam app. [OpenCV Python package guidance](https://pypi.org/project/opencv-python/), [Ultralytics install guidance](https://docs.ultralytics.com/quickstart/), [InsightFace PyPI metadata](https://pypi.org/project/insightface/)

## Ultralytics YOLO

Ultralytics exposes `from ultralytics import YOLO`, accepts a model weight path, and predicts on NumPy frames. Its quickstart says pretrained names such as `yolo26n.pt` download automatically when absent. For offline operation, accept an explicit `.pt` file path, expand and resolve it, check that it is a readable file before constructing `YOLO(path)`, and return a clear local-model error if it is missing. Never silently substitute a built-in model name. [Ultralytics Python prediction and weight download behavior](https://docs.ultralytics.com/quickstart/#use-ultralytics-with-python), [Ultralytics prediction API](https://docs.ultralytics.com/modes/predict/)

Ultralytics 8.4 supports `YOLO_OFFLINE` for its online check and `YOLO_AUTOINSTALL=false` to disable automatic requirement installation. Set both before importing Ultralytics, and disable settings synchronization. These controls supplement the required existing local `.pt` check; they do not replace it. Keep inference on NumPy frames supplied by the app, with `save=False` and `stream=False`, and normalize boxes, class IDs/names, and confidence. The official package name `ultralytics-opencv-headless` retains the same API but is intended for no-display environments. This local Windows app can use `ultralytics` with shared `opencv-python`. [Ultralytics source: online check](https://github.com/ultralytics/ultralytics/blob/main/ultralytics/utils/__init__.py), [automatic requirement installation](https://github.com/ultralytics/ultralytics/blob/main/ultralytics/utils/checks.py), [headless install guidance](https://docs.ultralytics.com/quickstart/#headless-server-installation)

Ultralytics identifies its package as AGPL-3.0-or-later on PyPI. Review the applicable license before redistributing or embedding it in a closed product. [Ultralytics PyPI metadata](https://pypi.org/project/ultralytics/)

## InsightFace and ONNX Runtime

The current PyPI release is InsightFace 2.1, released October 3, 2026. It supports Python 3.10+, provides a universal wheel, and declares `opencv-python` and CPU `onnxruntime` dependencies. That fits the application's Python 3.11 floor and avoids a local source build. In contrast, 0.7.3 is published as source distribution only. Pinning 0.7.3 can require a Windows C++/Cython build toolchain and has known compatibility problems with newer NumPy. Prefer `insightface>=2.1,<2.2` for this Python app. [InsightFace 2.1 PyPI release](https://pypi.org/project/insightface/), [InsightFace 0.7.3 release files](https://pypi.org/project/insightface/0.7.3/)

ONNX Runtime publishes CPU and CUDA Python packages. CPU is the lowest-friction default. NVIDIA inference requires a matching ONNX Runtime GPU build plus compatible CUDA/cuDNN DLLs. Keep only one ONNX Runtime distribution installed. Request `CPUExecutionProvider` explicitly for CPU behavior; CUDA selection must follow the installed runtime's compatibility table. Windows builds require the Visual C++ 2019 runtime. [ONNX Runtime installation](https://onnxruntime.ai/docs/install/), [CUDA provider compatibility](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)

InsightFace `FaceAnalysis()` defaults to `buffalo_l` and may download its pack on first use. This app only needs detection. Load an explicit existing `.onnx` file with `insightface.model_zoo.get_model(path, providers=["CPUExecutionProvider"], download=False)`. Confirm `taskname == "detection"`, call `prepare(ctx_id=-1, input_size=(size, size), det_thresh=threshold)`, then `detect(frame, max_num=...)`. This API loads one detector and does not initialize recognition or pack downloading. Place model files under the user's data directory, such as `%LOCALAPPDATA%/SpyDER/models/`, and keep paths configurable. Missing files should produce setup status while camera preview continues. [InsightFace 2.1 model zoo source](https://github.com/deepinsight/insightface/blob/master/python-package/insightface/model_zoo/model_zoo.py), [InsightFace detection model guide](https://github.com/deepinsight/insightface/blob/master/python-package/docs/model_zoo.md)

InsightFace Python code is MIT licensed, but its supplied pretrained models are for non-commercial research, whether downloaded automatically or manually. The code license does not grant commercial rights to model weights. Check the terms for every user-supplied model. [InsightFace model license terms](https://github.com/deepinsight/insightface/blob/master/python-package/docs/model_zoo.md#model-licenses)

## Compatibility and scope

Keep ML imports lazy and inference optional. Run inference locally in a bounded worker that consumes recent frames. Inference failures should update per-camera status without stopping capture. Keep model paths and provider options in validated local camera settings. Return normalized detections rather than library-specific objects. Generic ONNX detection needs its own output contract; arbitrary ONNX exports do not share one schema.

Official docs and package metadata can change. Findings reflect sources checked on 2026-10-13. No ML packages or models were installed for this research.

## Sources

- [Ultralytics quickstart](https://docs.ultralytics.com/quickstart/)
- [Ultralytics predict mode](https://docs.ultralytics.com/modes/predict/)
- [OpenCV Python wheels](https://pypi.org/project/opencv-python/)
- [InsightFace PyPI page](https://pypi.org/project/insightface/)
- [InsightFace 0.7.3 PyPI release files](https://pypi.org/project/insightface/0.7.3/)
- [InsightFace model zoo and license](https://github.com/deepinsight/insightface/blob/master/python-package/docs/model_zoo.md)
- [InsightFace model zoo source](https://github.com/deepinsight/insightface/blob/master/python-package/insightface/model_zoo/model_zoo.py)
- [ONNX Runtime install guide](https://onnxruntime.ai/docs/install/)
- [ONNX Runtime CUDA provider compatibility](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)
