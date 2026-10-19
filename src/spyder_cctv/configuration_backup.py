"""Validated configuration export, preview, and restart-time restore."""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .config import CameraConfig, SettingsProfile
from .recording_profiles import DEFAULT_SETTINGS, validate_settings
from .workflow import _validate_graph

MAX_BACKUP_BYTES = 2 * 1024 * 1024
_VERSION = 1
_PENDING = ".configuration-restore.json"
_JOURNAL = ".configuration-restore-journal.json"
_SECTIONS = {"version", "config", "preferences", "workflows", "recording_settings"}


class ConfigurationBackup:
    """Export and stage application settings without changing live services."""

    def __init__(self, manager: Any, recorder: Any, workflows: Any) -> None:
        self.manager = manager
        self.recorder = recorder
        self.workflows = workflows
        config_path = getattr(manager, "_config_path", None)
        if config_path is None:
            raise ValueError("Configuration backup requires a persistent config path")
        self.config_path = Path(config_path).resolve()
        self.pending_path = self.config_path.parent / _PENDING

    @property
    def pending(self) -> bool:
        return self.pending_path.exists()

    def export(self) -> str:
        cameras = [asdict(worker.config) for worker in self.manager._snapshot()]
        warnings = []
        for camera in cameras:
            vision = camera.get("vision")
            if vision:
                if any(vision.get(key) for key in ("model", "recognition_model", "identity_gallery", "classifier_model")):
                    warnings.append("Camera model paths are omitted; reconfigure local models after restore.")
                for key in ("model", "recognition_model", "identity_gallery", "classifier_model"):
                    vision[key] = None
                if vision.get("engine") != "opencv":
                    camera["pipeline"] = "motion"
                    camera["vision"] = None
        workflows = self.workflows.list().get("workflows", [])
        for graph in workflows:
            graph["enabled"] = False
        payload = {
            "version": _VERSION,
            "config": {
                "version": 1,
                "cameras": cameras,
                "profiles": [asdict(profile) for profile in self.manager._profiles.values()],
            },
            "preferences": {"version": 1, "pause_when_unfocused": bool(self.manager._preferences.snapshot()["pause_when_unfocused"])},
            "workflows": {"workflows": workflows},
            "recording_settings": dict(getattr(self.recorder, "_settings", DEFAULT_SETTINGS)),
        }
        result = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
        if len(result.encode("utf-8")) > MAX_BACKUP_BYTES:
            raise ValueError("Configuration backup exceeds 2 MiB")
        return result

    def preview(self, raw: str | bytes) -> dict[str, Any]:
        data = self._validate(raw)
        camera_ids = {item["id"] for item in data["config"]["cameras"]}
        missing = sorted({camera for graph in data["workflows"]["workflows"] for camera in graph["camera_ids"] if camera not in camera_ids})
        warnings = []
        if missing:
            warnings.append(f"{len(missing)} workflow camera reference(s) are missing.")
        if data["workflows"]["workflows"]:
            warnings.append("Workflows will be restored disabled.")
        if any(camera.get("pipeline") == "vision" for camera in data["config"]["cameras"]):
            warnings.append("Local vision model paths may require reconfiguration.")
        return {
            "valid": True,
            "counts": {"cameras": len(data["config"]["cameras"]), "profiles": len(data["config"]["profiles"]), "workflows": len(data["workflows"]["workflows"])},
            "warnings": warnings,
            "missing_camera_references": missing,
            "restart_required": True,
        }

    def restore(self, raw: str | bytes) -> dict[str, Any]:
        data = self._validate(raw)
        if self.pending:
            raise RuntimeError("A configuration restore is already pending restart")
        self.pending_path.parent.mkdir(parents=True, exist_ok=True)
        self._atomic_write(self.pending_path, json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"))
        result = self.preview(raw)
        result["pending"] = True
        return result

    @staticmethod
    def apply_pending(config_path: Path, media_dir: Path | None = None) -> bool:
        """Apply staged settings before services load; preserve prior files on failure."""
        config_path = Path(config_path).resolve()
        root = config_path.parent
        pending = root / _PENDING
        journal = root / _JOURNAL
        if not pending.exists():
            if journal.exists():
                raise RuntimeError("Restore journal exists without pending configuration; preserve files for recovery")
            return False
        raw = pending.read_bytes()
        data = ConfigurationBackup._validate_payload(raw)
        target_media = Path(media_dir).resolve() if media_dir is not None else root / "media"
        targets = {
            config_path: json.dumps(data["config"], ensure_ascii=False, indent=2).encode() + b"\n",
            root / "preferences.json": json.dumps(data["preferences"], ensure_ascii=False, indent=2).encode() + b"\n",
            root / "workflows.json": json.dumps(data["workflows"], ensure_ascii=False, indent=2).encode() + b"\n",
            target_media / "recording-settings.json": json.dumps(data["recording_settings"], ensure_ascii=False, indent=2).encode() + b"\n",
        }
        old = [path.read_bytes().decode("latin1") if path.exists() else None for path in targets]
        ConfigurationBackup._atomic_write(journal, json.dumps({"version": 1, "old": old}).encode("utf-8"))
        try:
            for path, contents in targets.items():
                ConfigurationBackup._atomic_write(path, contents)
            pending.unlink()
            journal.unlink()
            return True
        except Exception:
            ConfigurationBackup._restore_journal(journal, list(targets))
            raise

    @staticmethod
    def recover_interrupted(config_path: Path, media_dir: Path | None = None) -> bool:
        """Roll back an interrupted apply before normal configuration loads."""
        journal = Path(config_path).resolve().parent / _JOURNAL
        if not journal.exists():
            return False
        root = Path(config_path).resolve().parent
        targets = [
            Path(config_path).resolve(),
            root / "preferences.json",
            root / "workflows.json",
            (Path(media_dir).resolve() if media_dir is not None else root / "media") / "recording-settings.json",
        ]
        ConfigurationBackup._restore_journal(journal, targets)
        return True

    @staticmethod
    def _restore_journal(journal: Path, targets: list[Path]) -> None:
        data = json.loads(journal.read_text(encoding="utf-8"))
        if (
            not isinstance(data, dict)
            or set(data) != {"version", "old"}
            or type(data["version"]) is not int
            or data["version"] != 1
            or not isinstance(data["old"], list)
            or len(data["old"]) != len(targets)
            or any(value is not None and not isinstance(value, str) for value in data["old"])
        ):
            raise RuntimeError("Invalid restore journal; preserve files for recovery")
        for path, value in zip(targets, data["old"]):
            if value is None:
                path.unlink(missing_ok=True)
            else:
                ConfigurationBackup._atomic_write(path, value.encode("latin1"))
        journal.unlink()

    @staticmethod
    def _validate(raw: str | bytes) -> dict[str, Any]:
        if not isinstance(raw, (str, bytes)):
            raise ValueError("Backup must be JSON text")
        encoded = raw.encode("utf-8") if isinstance(raw, str) else raw
        return ConfigurationBackup._validate_payload(encoded)

    @staticmethod
    def _validate_payload(raw: bytes) -> dict[str, Any]:
        if len(raw) > MAX_BACKUP_BYTES:
            raise ValueError("Configuration backup exceeds 2 MiB")
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("Invalid configuration backup JSON") from error
        if not isinstance(data, dict) or set(data) != _SECTIONS or type(data["version"]) is not int or data["version"] != _VERSION:
            raise ValueError("Unknown configuration backup fields or version")
        config = data["config"]
        if not isinstance(config, dict) or set(config) != {"version", "cameras", "profiles"} or type(config["version"]) is not int or config["version"] != 1:
            raise ValueError("Invalid camera configuration section")
        # Parse isolated in-memory documents; never resolve or copy referenced files.
        if not isinstance(config["cameras"], list) or not isinstance(config["profiles"], list):
            raise ValueError("Invalid cameras or profiles")
        camera_rows = []
        for raw_camera in config["cameras"]:
            if not isinstance(raw_camera, dict):
                raise ValueError("Each camera must be an object")
            item = dict(raw_camera)
            vision = item.get("vision")
            if vision is not None:
                if not isinstance(vision, dict):
                    raise ValueError("Invalid vision configuration")
                # Local model and gallery paths belong to this machine. Drop them.
                vision = dict(vision)
                for key in ("model", "recognition_model", "identity_gallery", "classifier_model"):
                    vision[key] = None
                if vision.get("engine") != "opencv":
                    item["pipeline"] = "motion"
                    item["vision"] = None
                else:
                    item["vision"] = vision
            camera_rows.append(item)
        try:
            cameras = [CameraConfig(**item) for item in camera_rows]
        except TypeError as error:
            raise ValueError("Camera contains missing or unknown fields") from error
        profiles = [SettingsProfile(**item) for item in config["profiles"]]
        ids = {profile.id for profile in profiles}
        if len(ids) != len(profiles) or len({p.name.casefold() for p in profiles}) != len(profiles):
            raise ValueError("Profile ids and names must be unique")
        if len({camera.id for camera in cameras}) != len(cameras) or any(camera.profile_id and camera.profile_id not in ids for camera in cameras):
            raise ValueError("Camera ids must be unique and profile references valid")
        if not isinstance(data["preferences"], dict) or set(data["preferences"]) != {"version", "pause_when_unfocused"} or type(data["preferences"]["version"]) is not int or data["preferences"]["version"] != 1 or type(data["preferences"]["pause_when_unfocused"]) is not bool:
            raise ValueError("Invalid preferences section")
        wf = data["workflows"]
        if not isinstance(wf, dict) or set(wf) != {"workflows"} or not isinstance(wf["workflows"], list) or len(wf["workflows"]) > 32:
            raise ValueError("Invalid workflows section")
        graphs = [_validate_graph(g) for g in wf["workflows"]]
        if len({g["id"] for g in graphs}) != len(graphs):
            raise ValueError("Duplicate workflow id")
        for graph in graphs:
            graph["enabled"] = False
        data["workflows"]["workflows"] = graphs
        # Normalize for safe restart: imported cameras never auto-start.
        data["config"]["cameras"] = []
        for camera in cameras:
            item = asdict(camera)
            item["autostart"] = False
            data["config"]["cameras"].append(item)
        data["recording_settings"] = validate_settings(data["recording_settings"])
        return data

    @staticmethod
    def _atomic_write(path: Path, contents: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(contents)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, path)
        finally:
            Path(name).unlink(missing_ok=True)
