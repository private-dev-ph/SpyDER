"""Validated configuration export, preview, and restart-time restore."""

from __future__ import annotations

import json
import os
import tempfile
from base64 import b64decode, b64encode
from contextlib import nullcontext
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .config import CameraConfig, SettingsProfile
from .recording_profiles import DEFAULT_SETTINGS, validate_settings
from .workflow import _validate_graph

MAX_BACKUP_BYTES = 2 * 1024 * 1024
MAX_JOURNAL_BYTES = 9 * MAX_BACKUP_BYTES
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
        return self.pending_path.exists() or self.pending_path.is_symlink()

    def export(self) -> str:
        mutation_lock = getattr(self.manager, "_mutations", None)
        with mutation_lock if mutation_lock is not None else nullcontext():
            cameras = [asdict(worker.config) for worker in self.manager._snapshot()]
            profiles = [asdict(profile) for profile in self.manager._profiles.values()]
        for camera in cameras:
            vision = camera.get("vision")
            if vision:
                for key in ("model", "recognition_model", "identity_gallery", "classifier_model"):
                    vision[key] = None
                vision["classifier_labels"] = []
                if vision.get("engine") != "opencv":
                    camera["pipeline"] = "motion"
                    camera["vision"] = None
        preferences = self.manager._preferences.snapshot()
        if preferences.get("storage_error"):
            raise ValueError("Cannot export because preferences storage is invalid")
        workflow_data = self.workflows.list()
        if workflow_data.get("storage_error"):
            raise ValueError("Cannot export because workflow storage is invalid")
        workflows = workflow_data.get("workflows", [])
        for graph in workflows:
            graph["enabled"] = False
        recorder_lock = getattr(self.recorder, "_lock", None)
        with recorder_lock if recorder_lock is not None else nullcontext():
            recording_settings = dict(getattr(self.recorder, "_settings", DEFAULT_SETTINGS))
        payload = {
            "version": _VERSION,
            "config": {
                "version": 1,
                "cameras": cameras,
                "profiles": profiles,
            },
            "preferences": {
                "version": 1,
                "pause_when_unfocused": preferences["pause_when_unfocused"],
            },
            "workflows": {"workflows": workflows},
            "recording_settings": recording_settings,
        }
        result = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
        if len(result.encode("utf-8")) > MAX_BACKUP_BYTES:
            raise ValueError("Configuration backup exceeds 2 MiB")
        return result

    def preview(self, raw: str | bytes) -> dict[str, Any]:
        data = self._validate(raw)
        camera_ids = {item["id"] for item in data["config"]["cameras"]}
        workflow_list = data["workflows"]["workflows"]
        referenced_cameras = {camera for graph in workflow_list for camera in graph["camera_ids"]}
        referenced_cameras.update(
            node["params"]["camera_id"]
            for graph in workflow_list
            for node in graph["nodes"]
            if node["type"] == "camera" and node["params"].get("camera_id")
        )
        missing = sorted(referenced_cameras - camera_ids)
        builtin_models = {"builtin-scrfd-500mf", "builtin-scrfd-2-5gf", "builtin-scrfd-10gf"}
        library = getattr(self.workflows, "model_library", None)
        local_models = {item["id"] for item in library.list()} if library is not None else set()
        model_refs = {
            node["params"]["model_id"]
            for graph in workflow_list
            for node in graph["nodes"]
            if node["type"] in ("model", "classifier") and node["params"].get("model_id")
        }
        missing_models = sorted(model_refs - builtin_models - local_models)
        warnings = []
        warnings.append("Model weights and model registry entries are not included in backups.")
        if missing:
            warnings.append(f"{len(missing)} workflow camera reference(s) are missing.")
        if data["workflows"]["workflows"]:
            warnings.append("Workflows will be restored disabled.")
        if missing_models:
            warnings.append(
                f"{len(missing_models)} workflow model reference(s) are unavailable "
                "on this computer."
            )
        if any(camera.get("pipeline") == "vision" for camera in data["config"]["cameras"]):
            warnings.append("Local vision model paths may require reconfiguration.")
        return {
            "valid": True,
            "counts": {
                "cameras": len(data["config"]["cameras"]),
                "profiles": len(data["config"]["profiles"]),
                "workflows": len(data["workflows"]["workflows"]),
            },
            "warnings": warnings,
            "missing_camera_references": missing,
            "missing_model_references": missing_models,
            "restart_required": True,
        }

    def restore(self, raw: str | bytes) -> dict[str, Any]:
        data = self._validate(raw)
        if self.pending or self.pending_path.is_symlink():
            raise RuntimeError("A configuration restore is already pending restart")
        if (self.config_path.parent / _JOURNAL).exists() or (
            self.config_path.parent / _JOURNAL
        ).is_symlink():
            raise RuntimeError("A restore journal needs recovery before staging another restore")
        result = self.preview(raw)
        self.pending_path.parent.mkdir(parents=True, exist_ok=True)
        self._atomic_write(
            self.pending_path, json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        )
        result["pending"] = True
        return result

    @staticmethod
    def apply_pending(config_path: Path, media_dir: Path | None = None) -> bool:
        """Apply staged settings before services load; preserve prior files on failure."""
        config_path = Path(config_path).resolve()
        root = config_path.parent
        pending = root / _PENDING
        journal = root / _JOURNAL
        if pending.is_symlink() or journal.is_symlink():
            raise RuntimeError("Restore control files cannot be symbolic links")
        if not pending.exists():
            if journal.exists():
                raise RuntimeError(
                    "Restore journal exists without pending configuration; "
                    "preserve files for recovery"
                )
            return False
        raw = ConfigurationBackup._read_bounded(pending, MAX_BACKUP_BYTES)
        data = ConfigurationBackup._validate_payload(raw)
        target_media = Path(media_dir).resolve() if media_dir is not None else root / "media"
        target_paths = ConfigurationBackup._target_paths(config_path, target_media)
        if journal.exists():
            raise RuntimeError(
                "Restore journal needs recovery before applying pending configuration"
            )
        targets = [
            json.dumps(data["config"], ensure_ascii=False, indent=2).encode() + b"\n",
            json.dumps(data["preferences"], ensure_ascii=False, indent=2).encode() + b"\n",
            json.dumps(data["workflows"], ensure_ascii=False, indent=2).encode() + b"\n",
            json.dumps(data["recording_settings"], ensure_ascii=False, indent=2).encode() + b"\n",
        ]
        old = []
        for path in target_paths:
            if path.is_symlink():
                raise RuntimeError("Restore target cannot be a symbolic link")
            old.append(
                b64encode(ConfigurationBackup._read_bounded(path, MAX_BACKUP_BYTES)).decode("ascii")
                if path.exists()
                else None
            )
        journal_data = {
            "version": 1,
            "config_path": str(config_path),
            "config_filename": config_path.name,
            "media_dir": str(target_media),
            "old": old,
        }
        ConfigurationBackup._atomic_write(journal, json.dumps(journal_data).encode("utf-8"))
        try:
            for path, contents in zip(target_paths, targets, strict=True):
                ConfigurationBackup._atomic_write(path, contents)
            journal.unlink()
            pending.unlink()
            return True
        except Exception:
            if journal.exists():
                ConfigurationBackup._restore_journal(journal, config_path, target_media)
                raise
            # All target writes completed before journal removal. Reapplying staged
            # settings is safe if removing the pending marker itself failed.
            return True

    @staticmethod
    def recover_interrupted(config_path: Path, media_dir: Path | None = None) -> bool:
        """Roll back an interrupted apply before normal configuration loads."""
        config_path = Path(config_path).resolve()
        journal = config_path.parent / _JOURNAL
        if not journal.exists():
            return False
        if journal.is_symlink():
            raise RuntimeError("Restore journal cannot be a symbolic link")
        raw = ConfigurationBackup._read_bounded(journal, MAX_JOURNAL_BYTES)
        try:
            journal_data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError("Invalid restore journal; preserve files for recovery") from error
        expected_media = (
            Path(media_dir).resolve() if media_dir is not None else config_path.parent / "media"
        )
        if (
            not isinstance(journal_data, dict)
            or journal_data.get("config_path") != str(config_path)
            or journal_data.get("config_filename") != config_path.name
            or journal_data.get("media_dir") != str(expected_media)
        ):
            raise RuntimeError("Restore journal target identity does not match startup paths")
        ConfigurationBackup._restore_journal(journal, config_path, expected_media, journal_data)
        return True

    @staticmethod
    def _restore_journal(
        journal: Path,
        config_path: Path,
        media_dir: Path,
        data: dict[str, Any] | None = None,
    ) -> None:
        if data is None:
            raw = ConfigurationBackup._read_bounded(journal, MAX_JOURNAL_BYTES)
            try:
                data = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise RuntimeError(
                    "Invalid restore journal; preserve files for recovery"
                ) from error
        if (
            not isinstance(data, dict)
            or data.get("config_path") != str(config_path)
            or data.get("config_filename") != config_path.name
            or data.get("media_dir") != str(media_dir)
        ):
            raise RuntimeError("Restore journal target identity does not match startup paths")
        targets = ConfigurationBackup._target_paths(config_path, media_dir)
        if (
            set(data) != {"version", "config_path", "config_filename", "media_dir", "old"}
            or type(data["version"]) is not int
            or data["version"] != 1
            or not isinstance(data["old"], list)
            or len(data["old"]) != len(targets)
            or any(value is not None and not isinstance(value, str) for value in data["old"])
        ):
            raise RuntimeError("Invalid restore journal; preserve files for recovery")
        for path, value in zip(targets, data["old"], strict=True):
            if path.is_symlink():
                raise RuntimeError("Restore target cannot be a symbolic link")
            if value is None:
                path.unlink(missing_ok=True)
            else:
                try:
                    previous = b64decode(value, validate=True)
                except (ValueError, TypeError) as error:
                    raise RuntimeError(
                        "Invalid restore journal; preserve files for recovery"
                    ) from error
                if len(previous) > MAX_BACKUP_BYTES:
                    raise RuntimeError("Restore journal target exceeds its recovery limit")
                ConfigurationBackup._atomic_write(path, previous)
        journal.unlink()

    @staticmethod
    def _target_paths(config_path: Path, media_dir: Path) -> list[Path]:
        root = config_path.parent
        paths = [
            config_path,
            root / "preferences.json",
            root / "workflows.json",
            media_dir / "recording-settings.json",
        ]
        if any(path.is_symlink() for path in paths):
            raise RuntimeError("Restore targets cannot be symbolic links")
        control_paths = {root / _PENDING, root / _JOURNAL}
        resolved_controls = {control.resolve() for control in control_paths}
        if any(path.resolve() in resolved_controls for path in paths):
            raise ValueError("Configuration path conflicts with restore control files")
        canonical = [path.resolve() for path in paths]
        if len(set(canonical)) != len(canonical):
            raise ValueError("Configuration and restore target paths must be distinct")
        return canonical

    @staticmethod
    def _read_bounded(path: Path, limit: int) -> bytes:
        if path.is_symlink():
            raise RuntimeError("Restore control and target files cannot be symbolic links")
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            raise
        if size > limit:
            raise ValueError(f"Restore file exceeds {limit} bytes")
        with path.open("rb") as stream:
            contents = stream.read(limit + 1)
        if len(contents) > limit:
            raise ValueError(f"Restore file exceeds {limit} bytes")
        return contents

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
        if (
            not isinstance(data, dict)
            or set(data) != _SECTIONS
            or type(data["version"]) is not int
            or data["version"] != _VERSION
        ):
            raise ValueError("Unknown configuration backup fields or version")
        config = data["config"]
        if (
            not isinstance(config, dict)
            or set(config) != {"version", "cameras", "profiles"}
            or type(config["version"]) is not int
            or config["version"] != 1
        ):
            raise ValueError("Invalid camera configuration section")
        # Parse isolated in-memory documents; never resolve or copy referenced files.
        if not isinstance(config["cameras"], list) or not isinstance(config["profiles"], list):
            raise ValueError("Invalid cameras or profiles")
        if len(config["cameras"]) > 64 or len(config["profiles"]) > 64:
            raise ValueError("Backups support at most 64 cameras and profiles")
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
                vision["classifier_labels"] = []
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
        try:
            profiles = [SettingsProfile(**item) for item in config["profiles"]]
        except TypeError as error:
            raise ValueError("Profile contains missing or unknown fields") from error
        ids = {profile.id for profile in profiles}
        if len(ids) != len(profiles) or len({p.name.casefold() for p in profiles}) != len(profiles):
            raise ValueError("Profile ids and names must be unique")
        if len({camera.id for camera in cameras}) != len(cameras) or any(
            camera.profile_id and camera.profile_id not in ids for camera in cameras
        ):
            raise ValueError("Camera ids must be unique and profile references valid")
        if (
            not isinstance(data["preferences"], dict)
            or set(data["preferences"]) != {"version", "pause_when_unfocused"}
            or type(data["preferences"]["version"]) is not int
            or data["preferences"]["version"] != 1
            or type(data["preferences"]["pause_when_unfocused"]) is not bool
        ):
            raise ValueError("Invalid preferences section")
        wf = data["workflows"]
        if (
            not isinstance(wf, dict)
            or set(wf) != {"workflows"}
            or not isinstance(wf["workflows"], list)
            or len(wf["workflows"]) > 32
        ):
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
