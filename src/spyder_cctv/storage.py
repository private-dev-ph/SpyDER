"""Persistent media output location, independent from models and configuration."""

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any


class StorageSettings:
    def __init__(self, path: Path, default_directory: Path) -> None:
        self.path = path
        self.default_directory = default_directory.resolve()
        self._lock = threading.RLock()
        self._directory = self.default_directory
        self._history: list[Path] = []
        self.error: str | None = None
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if (
                    not isinstance(data, dict)
                    or set(data) != {"version", "media_directory", "previous_directories"}
                    or data["version"] != 1
                    or not isinstance(data["previous_directories"], list)
                    or len(data["previous_directories"]) > 32
                ):
                    raise ValueError("Invalid storage settings")
                self._directory = self._validate(data["media_directory"])
                self._history = [self._validate(value) for value in data["previous_directories"]]
            except (ValueError, OSError, TypeError) as error:
                self.error = f"Cannot read storage settings: {error}"

    @staticmethod
    def _validate(value: str) -> Path:
        if not isinstance(value, str) or not value.strip() or len(value) > 4096:
            raise ValueError("Choose an absolute local folder path")
        path = Path(value.strip()).expanduser()
        if not path.is_absolute() or "://" in value:
            raise ValueError("Choose an absolute local folder path")
        return path.resolve()

    @property
    def directory(self) -> Path:
        with self._lock:
            return self._directory

    def archives(self, active: Path) -> list[Path]:
        with self._lock:
            return list(
                dict.fromkeys(p for p in [self.default_directory, *self._history] if p != active)
            )

    def snapshot(self, active: Path, *, overridden: bool = False) -> dict[str, Any]:
        with self._lock:
            return {
                "media_directory": str(active),
                "configured_media_directory": str(self._directory),
                "default_media_directory": str(self.default_directory),
                "previous_directories": [str(p) for p in self.archives(active)],
                "restart_required": not overridden and active != self._directory,
                "command_line_override": overridden,
                "storage_settings_error": self.error,
            }

    def save(self, value: str, active: Path) -> dict[str, Any]:
        with self._lock:
            if self.error:
                raise RuntimeError("Repair storage settings before saving a new output folder")
            directory = self._validate(value)
            history = list(dict.fromkeys([*self._history, self._directory, active]))
            history = [p for p in history if p != directory]
            if len(history) > 32:
                raise ValueError("Storage folder history is full; keep using an existing folder")
            # Verify write access before persisting a location that would break startup.
            directory.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryFile(dir=directory) as probe:
                probe.write(b"SpyDER storage check")
                probe.flush()
            self.path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(prefix=".storage-", dir=self.path.parent)
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                    json.dump(
                        {
                            "version": 1,
                            "media_directory": str(directory),
                            "previous_directories": [str(p) for p in history],
                        },
                        stream,
                        indent=2,
                    )
                    stream.write("\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.path)
            finally:
                Path(temporary).unlink(missing_ok=True)
            self._directory = directory
            self._history = history
            return self.snapshot(active)
