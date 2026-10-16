"""Bounded, expiring Vision Lab drafts independent of live camera settings."""

import re
import threading
import time
from dataclasses import asdict, dataclass
from typing import Any

from spyder_cctv.analysis_runtime import AnalysisRuntime
from spyder_cctv.capture import encode_jpeg
from spyder_cctv.motion_config import AnalysisConfig


@dataclass
class Draft:
    camera_id: str
    settings: AnalysisConfig
    runtime: Any
    touched: float
    revision: int


class AnalysisPreviews:
    """Four local preview leases; no capture ownership or configuration writes."""

    def __init__(self, manager: Any, *, ttl: float = 20, limit: int = 4) -> None:
        self.manager = manager
        self.ttl, self.limit = ttl, limit
        self._lock = threading.RLock()
        self._sessions: dict[str, Draft] = {}
        self._released: dict[str, float] = {}
        self._retiring: list[Any] = []
        self._revision = 0
        self._stop = threading.Event()
        self._janitor = threading.Thread(
            target=self._expire, name="analysis-preview-leases", daemon=True
        )
        self._janitor.start()

    @staticmethod
    def _validate(session: str) -> None:
        if not re.fullmatch(r"[a-zA-Z0-9_-]{8,64}", session):
            raise ValueError("Invalid preview session")

    def _retire(self, draft: Draft) -> None:
        if draft.runtime is not None:
            try:
                draft.runtime.close(timeout=0.05)
            except RuntimeError:
                self._retiring.append(draft.runtime)

    def _prune(self) -> None:
        now = time.monotonic()
        self._retiring = [runtime for runtime in self._retiring if runtime.is_alive]
        self._released = {key: until for key, until in self._released.items() if until > now}
        for key, draft in list(self._sessions.items()):
            if now - draft.touched > self.ttl:
                self._retire(self._sessions.pop(key))

    def configure(self, session: str, camera_id: str, settings: object) -> dict:
        self._validate(session)
        if not isinstance(camera_id, str):
            raise ValueError("Select a camera")
        config = AnalysisConfig.from_dict(settings)
        self.manager.get_worker(camera_id)
        with self._lock:
            self._prune()
            if self._stop.is_set() or session in self._released:
                raise RuntimeError("Preview session closed")
            old = self._sessions.get(session)
            if old and old.camera_id == camera_id and old.settings == config:
                old.touched = time.monotonic()
                return self._snapshot(old)
            if old and old.camera_id == camera_id and old.runtime and config.enabled:
                old.runtime.reconfigure(config)
                old.settings, old.touched = config, time.monotonic()
                self._revision += 1
                old.revision = self._revision
                return self._snapshot(old)
            if old:
                self._retire(self._sessions.pop(session))
            if len(self._sessions) + len(self._retiring) >= self.limit:
                raise RuntimeError(
                    "Preview limit reached; close another Vision Lab tab "
                    "or wait for analysis to stop"
                )
            runtime = AnalysisRuntime(config) if config.enabled else None
            self._revision += 1
            draft = Draft(camera_id, config, runtime, time.monotonic(), self._revision)
            self._sessions[session] = draft
            return self._snapshot(draft)

    def _sample(self, draft: Draft) -> tuple[Any, dict]:
        worker = self.manager.get_worker(draft.camera_id)
        frame = worker.raw_frame()
        if frame is None:
            live = worker.status()["state"] in ("running", "starting")
            return None, {
                "state": "loading" if live else "paused",
                "message": "Waiting for a fresh preview frame"
                if live
                else "Start this camera in Control Room to preview settings",
            }
        result = (
            draft.runtime.process(frame)
            if draft.runtime
            else {"state": "disabled", "regions": [], "tracks": []}
        )
        return frame, result

    def _snapshot(self, draft: Draft) -> dict:
        _, result = self._sample(draft)
        worker = self.manager.get_worker(draft.camera_id)
        return {
            "camera_id": draft.camera_id,
            "settings": asdict(draft.settings),
            "runtime": result,
            "state": worker.status()["state"],
            "pipeline": worker.config.pipeline,
            "revision": draft.revision,
        }

    def _draft(self, session: str) -> Draft:
        self._validate(session)
        self._prune()
        draft = self._sessions[session]
        draft.touched = time.monotonic()
        return draft

    def snapshot(self, session: str) -> dict:
        with self._lock:
            return self._snapshot(self._draft(session))

    def image(self, session: str, *, mask: bool = False) -> bytes | None:
        with self._lock:
            draft = self._draft(session)
            frame, result = self._sample(draft)
            if frame is None:
                return None
            if mask:
                return draft.runtime.mask() if draft.runtime else None
            if draft.runtime:
                frame = draft.runtime.annotate(frame, result)
            return encode_jpeg(frame)

    def release(self, session: str) -> None:
        self._validate(session)
        with self._lock:
            self._prune()
            if draft := self._sessions.pop(session, None):
                self._retire(draft)
            # Reject late requests from a tab that has already left this preview.
            self._released[session] = time.monotonic() + 60
            if len(self._released) > 256:
                self._released.pop(next(iter(self._released)))

    def _expire(self) -> None:
        while not self._stop.wait(1):
            with self._lock:
                self._prune()

    def close(self) -> None:
        self._stop.set()
        self._janitor.join(1)
        with self._lock:
            for draft in self._sessions.values():
                self._retire(draft)
            self._sessions.clear()
