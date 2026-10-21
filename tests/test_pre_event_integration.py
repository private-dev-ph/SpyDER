"""Exercise a triggered clip through camera workers, workflows, and the real encoder."""

import time

import cv2
import numpy as np

from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig
from spyder_cctv.recording import RecordingService
from spyder_cctv.workflow import WorkflowService


def wait_for(predicate, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.03)
    raise AssertionError("Pre-event integration condition did not become true")


def test_event_attachment_includes_worker_history_and_finishes_after_trigger(tmp_path):
    post_trigger = False

    class Capture:
        def __init__(self, source):
            pass

        def read(self):
            color = (20, 220, 20) if post_trigger else (20, 20, 230)
            return True, np.full((90, 160, 3), color, dtype=np.uint8)

        def close(self):
            pass

    manager = CameraManager(
        [CameraConfig("front", 0, fps=15)], capture_factory=Capture, media_dir=tmp_path / "media"
    )
    recorder = RecordingService(manager, tmp_path / "media")
    workflow = WorkflowService(manager, recorder, tmp_path / "config")
    # Trigger exactly once; exercise the production action path without unrelated inference.
    workflow._stop.set()
    workflow._thread.join(2)
    try:
        workflow.save(
            {
                "id": "arrival",
                "name": "Arrival",
                "enabled": True,
                "camera_ids": ["front"],
                "nodes": [
                    {"id": "source", "type": "detections", "x": 0, "y": 0, "params": {}},
                    {
                        "id": "event",
                        "type": "event",
                        "x": 1,
                        "y": 0,
                        "params": {
                            "message": "Seen",
                            "attachment": "recording",
                            "pre_event_seconds": 2,
                            "duration_seconds": 1,
                        },
                    },
                ],
                "edges": [{"from": "source", "to": "event"}],
            }
        )
        worker = manager.get_worker("front")
        worker.start()
        wait_for(lambda: manager.pre_event_buffer.status()["cameras"]["front"]["frames"] >= 5)
        post_trigger = True
        workflow._stop.clear()
        workflow._act(
            "event",
            {
                "message": "Seen",
                "attachment": "recording",
                "pre_event_seconds": 2,
                "duration_seconds": 1,
            },
            "arrival",
            "front",
            "Arrival",
        )
        wait_for(lambda: bool(workflow.event_store.list()["events"]))
        wait_for(lambda: bool(workflow.event_store.list()["events"][0]["media"]))
        event = workflow.event_store.list()["events"][0]
        assert event.get("attachment_status") != "error"
        item = recorder.status()["items"][0]
        assert item["requested_pre_event_seconds"] == 2
        assert 0.5 <= item["pre_event_seconds"] <= 2
        assert item["pre_event_seconds"] + 0.8 <= item["duration_seconds"] <= 3.2
        video = cv2.VideoCapture(str(recorder.media_path(item["id"])))
        try:
            colors = []
            while True:
                ok, frame = video.read()
                if not ok:
                    break
                h, w = frame.shape[:2]
                colors.append(frame[h // 3 : 2 * h // 3, w // 3 : 2 * w // 3].mean(axis=(0, 1)))
        finally:
            video.release()
        assert len(colors) >= 8
        assert colors[0][2] > 2 * colors[0][1]  # Before: red.
        assert colors[-1][1] > 2 * colors[-1][2]  # After: green.
        assert recorder.status()["state"] == "idle"
        assert not recorder.status()["writer_active"]
    finally:
        workflow.close()
        recorder.close()
        manager.close()
