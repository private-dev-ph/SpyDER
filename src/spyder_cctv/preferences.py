"""Persistent user preferences for the local camera server."""

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any


class PreferencesStorageError(RuntimeError):
    """Preference data cannot be read or safely replaced."""


class Preferences:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._pause_when_unfocused = True
        self._configured = False
        self._storage_error: str | None = None
        if path is not None and path.exists():
            self._load()

    def _load(self) -> None:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if (
                not isinstance(data, dict)
                or set(data) != {"version", "pause_when_unfocused"}
                or type(data["version"]) is not int
                or data["version"] != 1
                or type(data["pause_when_unfocused"]) is not bool
            ):
                raise ValueError("Expected version 1 preference object")
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            self._storage_error = f"Cannot read preferences file: {error}"
            return
        self._pause_when_unfocused = data["pause_when_unfocused"]
        self._configured = True

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "pause_when_unfocused": self._pause_when_unfocused,
                "configured": self._configured,
                "storage_error": self._storage_error,
            }

    def set_pause_when_unfocused(self, value: bool) -> dict[str, Any]:
        if type(value) is not bool:
            raise ValueError("pause_when_unfocused must be a boolean")
        with self._lock:
            if self._storage_error is not None:
                raise PreferencesStorageError(
                    "Cannot save preference because the preferences file is invalid; "
                    "preserve or repair preferences.json first"
                )
            if self.path is not None:
                self._write(value)
            self._pause_when_unfocused = value
            self._configured = True
            self._storage_error = None
            return self.snapshot()

    def _write(self, value: bool) -> None:
        assert self.path is not None
        temp_path: str | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, temp_path = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
            )
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
                json.dump(
                    {"version": 1, "pause_when_unfocused": value},
                    stream,
                    indent=2,
                )
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_path, self.path)
        except OSError as error:
            raise PreferencesStorageError(f"Cannot save preferences: {error}") from error
        finally:
            if temp_path is not None:
                try:
                    os.unlink(temp_path)
                except FileNotFoundError:
                    pass
