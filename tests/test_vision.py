import cv2
import numpy as np

from spyder_cctv.capture import OpenCVCapture, encode_jpeg
from spyder_cctv.vision import Motion


def test_motion_and_jpeg():
    pipeline = Motion()
    black = np.zeros((32, 32, 3), dtype=np.uint8)
    white = np.full_like(black, 255)
    assert pipeline.process(black)[1]["motion_fraction"] == 0
    assert pipeline.process(white)[1]["motion_fraction"] == 1
    encoded = encode_jpeg(white)
    decoded = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_COLOR)
    assert decoded.shape == white.shape


def test_real_opencv_file_adapter(tmp_path):
    path = tmp_path / "clip.avi"
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 10, (32, 32))
    assert writer.isOpened(), "Test requires MJPG encoder"
    try:
        for _ in range(3):
            writer.write(np.zeros((32, 32, 3), dtype=np.uint8))
    finally:
        writer.release()
    capture = OpenCVCapture(str(path))
    try:
        ok, frame = capture.read()
        assert ok and frame.shape == (32, 32, 3)
    finally:
        capture.close()
