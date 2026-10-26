"""Portable, checksummed ZIP64 backups of SpyDER persistent application data."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import stat
import tempfile
import zipfile
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import Any

FORMAT = "spyder-complete-backup"
VERSION = 1
MANIFEST = "manifest.json"
MAX_FILES = 100_000
MAX_TOTAL = 1 << 40
MAX_MANIFEST = 16 << 20
CHUNK = 1024 * 1024
_SKIP_PARTS = {"__pycache__", "tmp", "temp", "cache", "caches", "journal", "journals"}
_SKIP_SUFFIXES = {".part", ".partial", ".tmp", ".lock", "-wal", "-shm", "-journal"}


def _is_link(path: Path) -> bool:
    if path.is_symlink():
        return True
    try:
        attributes = getattr(path.lstat(), "st_file_attributes", 0)
    except OSError:
        return False
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse)


def _progress(
    callback: Callable[..., Any] | None,
    current: int,
    total: int,
    name: str,
    phase: str = "processing",
    byte_count: int = 0,
) -> None:
    if callback is None:
        return
    callback(
        {
            "phase": phase,
            "current": current,
            "total": total,
            "bytes": byte_count,
            "path": name,
            "message": f"{phase}: {name}",
        }
    )


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _hash_file(
    path: Path, progress: Callable[..., Any] | None = None, name: str = "", phase: str = "hash"
) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(CHUNK):
            digest.update(chunk)
            size += len(chunk)
            _progress(progress, size, path.stat().st_size, name, phase, size)
    return digest.hexdigest(), size


def _read_json(path: Path, maximum: int = 64 * 1024 * 1024) -> Any:
    if path.stat().st_size > maximum:
        raise ValueError(f"JSON file exceeds {maximum // (1024 * 1024)} MiB: {path.name}")
    return json.loads(path.read_text(encoding="utf-8"))


def _iter_files(
    root: Path, roots: list[tuple[Path, str]], exclude_dirs: list[Path] | None = None
) -> list[tuple[Path, str]]:
    found: dict[str, tuple[Path, str]] = {}
    excluded = [path.resolve() for path in (exclude_dirs or [])]
    for base, prefix in roots:
        if prefix.startswith("appdata/") and any(
            base.resolve() == excluded_root or _inside(base, excluded_root)
            for excluded_root in excluded
        ):
            continue
        if not base.exists():
            continue
        if _is_link(base):
            raise ValueError(f"Persistent data root is a symlink: {base}")
        if base.is_file():
            name = prefix
            if name.casefold() in found:
                raise ValueError(f"Duplicate backup path: {name}")
            found[name.casefold()] = (base, name)
            continue
        for directory, dirs, files in os.walk(base, followlinks=False):
            current = Path(directory)
            keep_dirs = []
            for name in dirs:
                child = current / name
                if (
                    name.casefold() in _SKIP_PARTS
                    or (current == base and prefix == "appdata" and name.casefold() == "media")
                    or _is_link(child)
                    or (
                        prefix.startswith("appdata/")
                        and any(_inside(child, excluded_root) for excluded_root in excluded)
                    )
                ):
                    continue
                keep_dirs.append(name)
            dirs[:] = keep_dirs
            for filename in files:
                path = current / filename
                if _is_link(path) or not path.is_file():
                    continue
                if (
                    prefix.startswith(("media", "media-archives/"))
                    and current == base
                    and filename in {"recording-settings.json", "recording-allowance.json"}
                ):
                    continue
                if filename.casefold().endswith(tuple(_SKIP_SUFFIXES)):
                    continue
                folded_filename = filename.casefold()
                if ".partial." in folded_filename or folded_filename in {
                    ".configuration-restore.json",
                    ".configuration-restore-journal.json",
                }:
                    continue
                rel = path.relative_to(base).as_posix()
                name = f"{prefix}/{rel}" if prefix else rel
                if PurePosixPath(name).suffix.casefold() in {".zip", ".bak", ".7z", ".tar", ".gz"}:
                    continue
                if name.casefold() in found:
                    raise ValueError(f"Duplicate backup path: {name}")
                found[name.casefold()] = (path, name)
    return sorted(found.values(), key=lambda pair: pair[1].casefold())


def _path_values(value: Any, keys: set[str] | None = None):
    keys = keys or {"model", "recognition_model", "identity_gallery", "classifier_model", "path"}
    if isinstance(value, dict):
        for key, child in value.items():
            if key in keys and isinstance(child, str) and Path(child).is_absolute():
                yield child
            yield from _path_values(child, keys)
    elif isinstance(value, list):
        for child in value:
            yield from _path_values(child, keys)


def _model_ids(value: Any):
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "model_id" and isinstance(child, str):
                yield child
            yield from _model_ids(child)
    elif isinstance(value, list):
        for child in value:
            yield from _model_ids(child)


def _safe_archive_name(name: str) -> bool:
    if name == MANIFEST:
        return True
    path = PurePosixPath(name)
    if (
        not name
        or "\\" in name
        or ":" in name
        or path.is_absolute()
        or any(part in {"", ".", ".."} for part in name.split("/"))
    ):
        return False
    parts = path.parts
    if (
        parts[0] not in {"appdata", "media", "media-archives", "external-models"}
        and name != "browser-state.json"
    ):
        return False
    if parts[0] == "appdata":
        if len(parts) < 2:
            return False
        if len(parts) > 2 and parts[1] not in {"models", "face-galleries", "events"}:
            return False
        if len(parts) > 2:
            if parts[1] == "events" and parts[2:] != ("events.json",):
                return False
            if parts[1] == "face-galleries" and (
                len(parts) != 4
                or len(parts[2]) != 32
                or any(char not in "0123456789abcdef" for char in parts[2])
                or parts[3] not in {"catalog.json", "gallery-v1.json"}
            ):
                return False
            if parts[1] == "models" and not (
                len(parts) == 3
                and parts[2] == "registry.json"
                or len(parts) >= 3
                and path.suffix.lower() in {".onnx", ".pt"}
            ):
                return False
    if parts[0] == "external-models" and path.suffix.lower() not in {".onnx", ".pt", ".json"}:
        return False
    if parts[0] == "external-models" and len(parts) < 3:
        return False
    if parts[0] in {"media", "media-archives"} and len(parts) < (2 if parts[0] == "media" else 3):
        return False
    reserved = {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }
    return all(
        part == part.rstrip(" .") and part.split(".")[0].upper() not in reserved for part in parts
    )


def _db_snapshot(source: Path, temp_root: Path, progress: Callable[..., Any] | None = None) -> Path:
    target = temp_root / f"db-{hashlib.sha256(str(source).encode()).hexdigest()}.sqlite3"
    src = sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True, timeout=5)
    dst = sqlite3.connect(target)
    callback_error: list[BaseException] = []

    def on_progress(status: int, remaining: int, total: int) -> None:
        if callback_error:
            return
        try:
            _progress(
                progress,
                total - remaining,
                total,
                str(source),
                "snapshot",
                (total - remaining) * 4096,
            )
        except BaseException as error:
            callback_error.append(error)

    try:
        src.backup(dst, pages=256, progress=on_progress)
        if callback_error:
            raise callback_error[0]
    finally:
        dst.close()
        src.close()
    return target


def _media_path(config_path: Path, media_dir: Path | None) -> Path:
    if media_dir is not None:
        selected = media_dir.expanduser()
        if _is_link(selected):
            raise ValueError("Media directory must not be a symlink or junction")
        return selected.resolve()
    settings_path = config_path.parent / "storage.json"
    try:
        value = _read_json(settings_path, 256 * 1024)["media_directory"]
        candidate = Path(value).expanduser()
        if candidate.is_absolute():
            if _is_link(candidate):
                raise ValueError("Media directory must not be a symlink or junction")
            return candidate.resolve()
    except (OSError, ValueError, TypeError, KeyError) as error:
        if isinstance(error, ValueError) and str(error).startswith("Media directory must"):
            raise
        pass
    return (config_path.parent / "media").resolve()


def _previous_media_paths(config_path: Path, active: Path, warnings: list[str]) -> list[Path]:
    try:
        value = _read_json(config_path.parent / "storage.json", 256 * 1024)
        previous = value.get("previous_directories", []) if isinstance(value, dict) else []
        if (
            not isinstance(value, dict)
            or set(value) != {"version", "media_directory", "previous_directories"}
            or type(value["version"]) is not int
            or value["version"] != 1
            or not isinstance(value["media_directory"], str)
            or not Path(value["media_directory"]).is_absolute()
            or not isinstance(previous, list)
            or len(previous) > 32
            or any(not isinstance(item, str) or not Path(item).is_absolute() for item in previous)
        ):
            raise ValueError("Invalid previous media directory list")
    except FileNotFoundError:
        return []
    except (OSError, ValueError, TypeError) as error:
        raise ValueError(f"Storage settings are invalid: {error}") from error
    paths: list[Path] = []
    for item in previous:
        try:
            path = Path(item).expanduser()
            if not path.is_absolute():
                raise ValueError("path is not absolute")
            if _is_link(path):
                raise ValueError("path is a symlink or junction")
            path = path.resolve()
            if path == active or path in paths:
                continue
            paths.append(path)
        except (TypeError, ValueError, OSError):
            warnings.append("A previous media directory path is invalid")
    return paths


class CompleteBackup:
    """Create, inspect, and safely restore complete SpyDER backup archives."""

    @staticmethod
    def create(
        config_path: Path,
        output: Path,
        *,
        media_dir: Path | None = None,
        include_media: bool = False,
        browser_data: dict | None = None,
        progress: Callable[..., Any] | None = None,
    ) -> dict:
        config_path = Path(config_path).expanduser()
        output = Path(output).expanduser()
        if _is_link(config_path) or _is_link(output):
            raise ValueError("Configuration and backup output must not be symlinks or junctions")
        config_path, output = config_path.resolve(), output.resolve()
        app = config_path.parent
        warnings: list[str] = []
        media = _media_path(config_path, media_dir)
        previous_media = _previous_media_paths(config_path, media, warnings)
        if any(path == app or _inside(app, path) for path in [media, *previous_media]):
            raise ValueError("Media directories must not contain the application data root")
        managed_dirs = [app / "models", app / "face-galleries", app / "events"]
        if any(
            _inside(path, managed) or _inside(managed, path)
            for path in [media, *previous_media]
            for managed in managed_dirs
        ):
            raise ValueError("Media directories must not overlap managed model or catalog data")
        if output.exists() or output.is_symlink():
            raise FileExistsError(f"Backup output already exists: {output}")
        media_roots = [media, *previous_media]
        if (
            _inside(output, app)
            or _inside(app, output)
            or any(_inside(output, source) or _inside(source, output) for source in media_roots)
        ):
            raise ValueError("Backup output must not overlap source data")
        roots = [
            (config_path, f"appdata/{config_path.name}"),
            *(
                (app / name, f"appdata/{name}")
                for name in (
                    "preferences.json",
                    "workflows.json",
                    "subflows.json",
                    "storage.json",
                    "schedules.json",
                    "camera-devices.json",
                    "workflow-history.sqlite3",
                )
            ),
            (app / "models", "appdata/models"),
            (app / "face-galleries", "appdata/face-galleries"),
            (app / "events", "appdata/events"),
            (media / "recording-settings.json", "media/recording-settings.json"),
            (media / "recording-allowance.json", "media/recording-allowance.json"),
        ]
        archived_previous_count = 0
        if not config_path.is_file():
            raise FileNotFoundError(f"Configuration file does not exist: {config_path}")
        output.parent.mkdir(parents=True, exist_ok=True)
        if include_media:
            archived_index = 0
            for index, media_root in enumerate(media_roots):
                if not media_root.is_dir():
                    warnings.append(f"Media directory is unavailable: {media_root}")
                    continue
                if index == 0:
                    prefix = "media"
                else:
                    prefix = f"media-archives/{archived_index}"
                    archived_previous_count += 1
                if index > 0:
                    archived_index += 1
                roots.append((media_root, prefix))
        tmp_dir = Path(tempfile.mkdtemp(prefix=".spyder-backup-", dir=output.parent))
        tmp_archive = tmp_dir / "archive.zip"
        hashes: dict[str, dict[str, Any]] = {}
        try:
            entries = _iter_files(app, roots, exclude_dirs=media_roots)
            external_models: dict[str, str] = {}
            portable_paths: dict[str, str] = {}
            registry = app / "models" / "registry.json"
            if registry.is_file():
                try:
                    records = _read_json(registry, 16 * 1024 * 1024)
                except (OSError, ValueError, UnicodeError):
                    records = []
                    warnings.append(
                        "Cannot read model registry; external references may be missing. "
                        "Registry stays unmodified."
                    )
                if isinstance(records, list):
                    present = {str(source.resolve()).casefold() for source, _ in entries}
                    for row in records:
                        if not isinstance(row, dict) or not isinstance(row.get("path"), str):
                            continue
                        model_path = Path(row["path"]).expanduser()
                        try:
                            model_path = model_path.resolve(strict=True)
                            if (
                                not model_path.is_file()
                                or model_path.is_symlink()
                                or (
                                    _inside(model_path, app)
                                    and not any(_inside(model_path, root) for root in media_roots)
                                )
                                or str(model_path).casefold() in present
                            ):
                                continue
                        except OSError:
                            warnings.append(
                                f"Registered model file is unavailable: {model_path.name}"
                            )
                            continue
                        model_id = (
                            row.get("id")
                            if isinstance(row.get("id"), str)
                            else hashlib.sha256(str(model_path).encode()).hexdigest()[:24]
                        )
                        relname = f"external-models/{model_id}/{model_path.name}"
                        if relname.casefold() not in {name.casefold() for _, name in entries}:
                            entries.append((model_path, relname))
                        external_models[str(row.get("id", model_id))] = relname
                        portable_paths[str(model_path)] = relname
                        present.add(str(model_path).casefold())
                    for source, name in entries:
                        if name.startswith("appdata/"):
                            portable_paths.setdefault(str(source.resolve()), name)
            # Preserve external vision, gallery, and classifier model references.
            for candidate in [config_path, *app.glob("face-galleries/*/catalog.json")]:
                if not candidate.is_file():
                    continue
                try:
                    refs = _read_json(
                        candidate,
                        16 * 1024 * 1024
                        if "face-galleries" in candidate.parts
                        else 64 * 1024 * 1024,
                    )
                except (OSError, ValueError, UnicodeError):
                    continue
                for ref in _path_values(refs):
                    try:
                        raw_path = Path(ref).expanduser()
                        if raw_path.is_symlink():
                            warnings.append(f"Skipped symlinked referenced file: {raw_path.name}")
                            continue
                        ref_path = raw_path.resolve(strict=True)
                        if not ref_path.is_file():
                            continue
                        if _inside(ref_path, app):
                            rel = "appdata/" + ref_path.relative_to(app).as_posix()
                        else:
                            path_hash = hashlib.sha256(str(ref_path).encode()).hexdigest()[:20]
                            rel = f"external-models/refs/{path_hash}/{ref_path.name}"
                            if rel.casefold() not in {name.casefold() for _, name in entries}:
                                entries.append((ref_path, rel))
                        portable_paths[ref] = rel
                        portable_paths[str(ref_path)] = rel
                    except (OSError, ValueError):
                        warnings.append(f"Referenced file is unavailable: {Path(ref).name}")
                        continue
            try:
                from spyder_cctv.cv.detectors import DetectorCatalog

                installed_detectors = DetectorCatalog().list()
                builtin_ids = {
                    "builtin-scrfd-500mf": "scrfd-500mf",
                    "builtin-scrfd-2-5gf": "scrfd-2.5gf",
                    "builtin-scrfd-10gf": "scrfd-10gf",
                }
                referenced: set[str] = set()
                for document_path in (app / "workflows.json", app / "subflows.json"):
                    if document_path.is_file():
                        try:
                            referenced.update(
                                _model_ids(
                                    _read_json(
                                        document_path,
                                        8 * 1024 * 1024
                                        if document_path.name == "subflows.json"
                                        else 64 * 1024 * 1024,
                                    )
                                )
                            )
                        except (OSError, ValueError, UnicodeError):
                            continue
                required_detectors = {
                    detector for model, detector in builtin_ids.items() if model in referenced
                }
                available_ids: set[str] = set()
                for descriptor in installed_detectors:
                    path_value = descriptor.get("path")
                    if (
                        descriptor["id"] not in required_detectors
                        or not descriptor.get("available")
                        or not path_value
                    ):
                        continue
                    source = Path(path_value)
                    available_ids.add(descriptor["id"])
                    name = f"appdata/models/builtin-detectors/{descriptor['id']}/{source.name}"
                    if name.casefold() not in {item.casefold() for _, item in entries}:
                        entries.append((source, name))
                    portable_paths[str(source)] = name
                for model_id, detector_id in builtin_ids.items():
                    if model_id in referenced and detector_id not in available_ids:
                        warnings.append(
                            f"Workflow references unavailable built-in detector weights: {model_id}"
                        )
            except (ImportError, OSError, ValueError) as error:
                warnings.append(f"Installed detector models could not be enumerated: {error}")
            entries.sort(key=lambda pair: pair[1].casefold())
            if len({name.casefold() for _, name in entries}) != len(entries):
                raise ValueError("Backup contains duplicate case-insensitive paths")
            for source, name in entries:
                if name.startswith("appdata/"):
                    portable_paths.setdefault(str(source.resolve()), name)
            for source, _name in entries:
                is_app_or_media = _inside(source, app) or _inside(source, media)
                if not is_app_or_media and _inside(output, source.parent):
                    raise ValueError("Backup output must not overlap external model source data")
            if len(entries) > MAX_FILES:
                raise ValueError("Backup contains too many files")
            initial_inventory = {
                name: (
                    str(source.resolve()),
                    source.stat().st_size,
                    source.stat().st_mtime_ns,
                    source.stat().st_ctime_ns,
                    source.stat().st_ino,
                )
                for source, name in entries
            }
            prepared: list[tuple[str, Path]] = []
            source_origins: dict[str, Path] = {}
            for source, name in entries:
                if source.suffix.lower() in {".sqlite", ".sqlite3", ".db"} and source.exists():
                    snapshot = _db_snapshot(source, tmp_dir, progress)
                    prepared.append((name, snapshot))
                    source_origins[name] = source
                elif source.suffix.lower() == ".json":
                    if source.stat().st_size > 64 * 1024 * 1024:
                        raise ValueError(f"Application JSON exceeds 64 MiB: {name}")
                    snapshot = (
                        tmp_dir / f"json-{hashlib.sha256(name.encode()).hexdigest()}.snapshot"
                    )
                    before = source.stat()
                    digest_bytes = 0
                    with source.open("rb") as source_stream, snapshot.open("xb") as target_stream:
                        while chunk := source_stream.read(CHUNK):
                            target_stream.write(chunk)
                            digest_bytes += len(chunk)
                            _progress(
                                progress,
                                digest_bytes,
                                before.st_size,
                                name,
                                "snapshot",
                                digest_bytes,
                            )
                    after = source.stat()
                    current_fingerprint = (
                        str(source.resolve()),
                        before.st_size,
                        before.st_mtime_ns,
                        before.st_ctime_ns,
                        before.st_ino,
                    )
                    if (
                        digest_bytes != before.st_size
                        or current_fingerprint != initial_inventory[name]
                        or (before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_ino)
                        != (after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_ino)
                    ):
                        raise ValueError(f"Source changed during backup snapshot: {name}")
                    prepared.append((name, snapshot))
                    source_origins[name] = source
                else:
                    prepared.append((name, source))
                    source_origins[name] = source
            if browser_data is not None:
                if (
                    not isinstance(browser_data, dict)
                    or set(browser_data) != {"version", "local_storage"}
                    or browser_data.get("version") != 1
                    or not isinstance(browser_data["local_storage"], dict)
                ):
                    raise ValueError("Browser state format is invalid")
                if len(browser_data["local_storage"]) > 1000 or any(
                    not isinstance(key, str)
                    or not key.startswith(("spyder.", "spyder-"))
                    or not isinstance(value, str)
                    for key, value in browser_data["local_storage"].items()
                ):
                    raise ValueError("Browser state contains unsupported values")
                encoded = json.dumps(
                    browser_data, ensure_ascii=False, separators=(",", ":")
                ).encode()
                if len(encoded) > 8 * 1024 * 1024:
                    raise ValueError("Browser state exceeds 8 MiB")
                browser_file = tmp_dir / "browser-state.json"
                browser_file.write_bytes(encoded)
                prepared.append(("browser-state.json", browser_file))
            if len(prepared) > MAX_FILES:
                raise ValueError("Backup contains too many files")
            total = 0
            with zipfile.ZipFile(
                tmp_archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True
            ) as archive:
                for name, source in prepared:
                    before = source.stat()
                    if name == "browser-state.json" and before.st_size > 8 * 1024 * 1024:
                        raise ValueError("Browser state exceeds 8 MiB")
                    if (
                        name.startswith("appdata/")
                        and name.endswith(".json")
                        and before.st_size > 64 * 1024 * 1024
                    ):
                        raise ValueError(f"Application JSON exceeds 64 MiB: {name}")
                    if (
                        name.endswith("/registry.json") or "face-galleries/" in name
                    ) and before.st_size > 16 * 1024 * 1024:
                        raise ValueError(f"Application catalog exceeds 16 MiB: {name}")
                    if name.endswith("/schedules.json") and before.st_size > 256 * 1024:
                        raise ValueError("Recording schedules exceed 256 KiB")
                    digest = hashlib.sha256()
                    copied = 0
                    with (
                        source.open("rb") as stream,
                        archive.open(name, "w", force_zip64=True) as target,
                    ):
                        while chunk := stream.read(CHUNK):
                            target.write(chunk)
                            digest.update(chunk)
                            copied += len(chunk)
                            if total + copied > MAX_TOTAL:
                                raise ValueError("Backup exceeds 1 TiB uncompressed limit")
                            _progress(progress, copied, before.st_size, name, "create", copied)
                    after = source.stat()
                    if (before.st_size, before.st_mtime_ns, before.st_ino) != (
                        after.st_size,
                        after.st_mtime_ns,
                        after.st_ino,
                    ) or copied != after.st_size:
                        raise ValueError(f"Source changed during backup: {name}")
                    if name in source_origins:
                        origin = source_origins[name]
                        origin_stat = origin.stat()
                        origin_fingerprint = (
                            str(origin.resolve()),
                            origin_stat.st_size,
                            origin_stat.st_mtime_ns,
                            origin_stat.st_ctime_ns,
                            origin_stat.st_ino,
                        )
                        if origin_fingerprint != initial_inventory[name]:
                            raise ValueError(f"Source changed during backup: {name}")
                    size = copied
                    total += size
                    hashes[name] = {"sha256": digest.hexdigest(), "size": size}
                manifest = {
                    "format": FORMAT,
                    "version": VERSION,
                    "files": hashes,
                    "file_count": len(hashes),
                    "total_bytes": total,
                    "warnings": warnings,
                    "include_media": include_media,
                    "external_models": external_models,
                    "portable_paths": portable_paths,
                    "config_filename": config_path.name,
                    "counts": {
                        "appdata": sum(name.startswith("appdata/") for name in hashes),
                        "media": sum(name.startswith("media/") for name in hashes),
                        "media_archives": sum(
                            name.startswith("media-archives/") for name in hashes
                        ),
                    },
                    "media_archive_count": archived_previous_count,
                }
                manifest_bytes = json.dumps(manifest, sort_keys=True, indent=2).encode()
                if len(manifest_bytes) > MAX_MANIFEST:
                    raise ValueError("Backup manifest exceeds 16 MiB")
                archive.writestr(MANIFEST, manifest_bytes)
            final_entries = _iter_files(app, roots, exclude_dirs=media_roots)
            final_names = {name for _, name in final_entries}
            for source, name in entries:
                if name not in final_names and (
                    not _inside(source, app) or any(_inside(source, root) for root in media_roots)
                ):
                    if source.is_file():
                        final_entries.append((source, name))
            final_inventory = {
                name: (
                    str(source.resolve()),
                    source.stat().st_size,
                    source.stat().st_mtime_ns,
                    source.stat().st_ctime_ns,
                    source.stat().st_ino,
                )
                for source, name in final_entries
            }
            if final_inventory != initial_inventory:
                raise ValueError(
                    "Persistent source files changed during backup: "
                    + repr(
                        {
                            "added": sorted(set(final_inventory) - set(initial_inventory)),
                            "removed": sorted(set(initial_inventory) - set(final_inventory)),
                            "changed": sorted(
                                name
                                for name in set(final_inventory) & set(initial_inventory)
                                if final_inventory[name] != initial_inventory[name]
                            ),
                        }
                    )
                )
            with tmp_archive.open("r+b") as stream:
                stream.flush()
                os.fsync(stream.fileno())
            # Windows rename fails when target exists and supports FAT/exFAT.
            if os.name == "nt":
                os.rename(tmp_archive, output)
            else:
                os.link(tmp_archive, output)
            return {
                "format": FORMAT,
                "version": VERSION,
                "path": str(output),
                "files": len(hashes),
                "file_count": len(hashes),
                "total_bytes": total,
                "counts": manifest["counts"],
                "include_media": include_media,
                "browser_data_included": browser_data is not None,
                "warnings": warnings,
            }
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    @staticmethod
    def _read(archive_path: Path, progress: Callable[..., Any] | None = None):
        archive_path = Path(archive_path).expanduser().resolve()
        with zipfile.ZipFile(archive_path, "r") as archive:
            infos = archive.infolist()
            if len(infos) > MAX_FILES + 1:
                raise ValueError("Archive contains too many entries")
            seen: dict[str, str] = {}
            for info in infos:
                name = info.filename
                if (
                    not _safe_archive_name(name)
                    or info.flag_bits & 1
                    or stat.S_ISLNK(info.external_attr >> 16)
                ):
                    raise ValueError(f"Unsafe archive entry: {name!r}")
                folded = name.casefold()
                if folded in seen:
                    raise ValueError(f"Duplicate archive entry: {name}")
                seen[folded] = name
            if MANIFEST not in seen:
                raise ValueError("Backup manifest is missing")
            info = archive.getinfo(MANIFEST)
            if info.file_size > MAX_MANIFEST:
                raise ValueError("Backup manifest exceeds 16 MiB")
            try:
                manifest_bytes = bytearray()
                with archive.open(info) as stream:
                    while chunk := stream.read(min(CHUNK, MAX_MANIFEST + 1 - len(manifest_bytes))):
                        manifest_bytes.extend(chunk)
                        if len(manifest_bytes) > MAX_MANIFEST:
                            raise ValueError("Backup manifest exceeds 16 MiB")
                manifest = json.loads(manifest_bytes)
            except (ValueError, UnicodeError, zipfile.BadZipFile) as error:
                raise ValueError("Backup manifest is invalid") from error
            if (
                not isinstance(manifest, dict)
                or manifest.get("format") != FORMAT
                or type(manifest.get("version")) is not int
                or manifest["version"] != VERSION
                or not isinstance(manifest.get("files"), dict)
            ):
                raise ValueError("Unsupported backup format or version")
            expected = manifest["files"]
            if (
                len(expected) > MAX_FILES
                or any(not isinstance(name, str) for name in expected)
                or MANIFEST in {name.casefold() for name in expected}
                or set(seen) != {name.casefold() for name in expected} | {MANIFEST}
                or any(
                    seen.get(name.casefold()) != name or not _safe_archive_name(name)
                    for name in expected
                )
            ):
                raise ValueError("Archive entries do not match manifest")
            config_name = manifest.get("config_filename", "config.json")
            if (
                not isinstance(config_name, str)
                or config_name != PurePosixPath(config_name).name
                or not _safe_archive_name(f"appdata/{config_name}")
            ):
                raise ValueError("Backup configuration filename is invalid")
            if f"appdata/{config_name}" not in expected:
                raise ValueError("Backup configuration file is missing")
            direct_allowed = {
                "preferences.json",
                "workflows.json",
                "subflows.json",
                "storage.json",
                "schedules.json",
                "camera-devices.json",
                "workflow-history.sqlite3",
                config_name,
            }
            if any(
                name.startswith("appdata/")
                and len(PurePosixPath(name).parts) == 2
                and PurePosixPath(name).parts[1] not in direct_allowed
                for name in expected
            ):
                raise ValueError("Archive contains unmanaged application data")
            if (
                "appdata/subflows.json" in expected
                and expected["appdata/subflows.json"]["size"] > 8 * 1024 * 1024
            ):
                raise ValueError("Subflow catalog exceeds 8 MiB")
            portable_paths = manifest.get("portable_paths", {})
            if not isinstance(portable_paths, dict) or any(
                not isinstance(key, str)
                or not isinstance(value, str)
                or not _safe_archive_name(value)
                or value not in expected
                for key, value in portable_paths.items()
            ):
                raise ValueError("Backup path map is invalid")
            if (
                type(manifest.get("include_media")) is not bool
                or type(manifest.get("media_archive_count", 0)) is not int
                or not 0 <= manifest.get("media_archive_count", 0) <= 32
                or not isinstance(manifest.get("warnings", []), list)
                or any(not isinstance(item, str) for item in manifest.get("warnings", []))
                or not isinstance(manifest.get("counts", {}), dict)
            ):
                raise ValueError("Backup manifest metadata is invalid")
            total = 0
            for name, record in expected.items():
                zi = archive.getinfo(name)
                total += zi.file_size
                if name == "browser-state.json" and zi.file_size > 8 * 1024 * 1024:
                    raise ValueError("Browser state exceeds 8 MiB")
                if (
                    name.startswith("appdata/")
                    and name.endswith(".json")
                    and zi.file_size > 64 * 1024 * 1024
                ):
                    raise ValueError(f"Application JSON exceeds 64 MiB: {name}")
                if (
                    name.endswith("/registry.json") or "face-galleries/" in name
                ) and zi.file_size > 16 * 1024 * 1024:
                    raise ValueError(f"Application catalog exceeds 16 MiB: {name}")
                if name.endswith("/schedules.json") and zi.file_size > 256 * 1024:
                    raise ValueError("Recording schedules exceed 256 KiB")
                if (
                    not isinstance(record, dict)
                    or type(record.get("size")) is not int
                    or record["size"] < 0
                    or total > MAX_TOTAL
                    or zi.file_size != record["size"]
                ):
                    raise ValueError("Backup size metadata is invalid")
                digest = hashlib.sha256()
                actual_size = 0
                with archive.open(zi) as stream:
                    while chunk := stream.read(CHUNK):
                        digest.update(chunk)
                        actual_size += len(chunk)
                        _progress(
                            progress,
                            actual_size,
                            zi.file_size,
                            name,
                            "verify",
                            total - zi.file_size + actual_size,
                        )
                        if (
                            actual_size > MAX_TOTAL
                            or total - zi.file_size + actual_size > MAX_TOTAL
                        ):
                            raise ValueError("Backup exceeds 1 TiB uncompressed limit")
                if (
                    not isinstance(record.get("sha256"), str)
                    or len(record["sha256"]) != 64
                    or actual_size != zi.file_size
                    or digest.hexdigest() != record.get("sha256")
                ):
                    raise ValueError(f"Checksum mismatch: {name}")
            if (
                type(manifest.get("file_count")) is not int
                or manifest["file_count"] != len(expected)
                or type(manifest.get("total_bytes")) is not int
                or manifest["total_bytes"] != total
            ):
                raise ValueError("Backup manifest counts are invalid")
            return archive_path, manifest

    @staticmethod
    def inspect(archive: Path, progress: Callable[..., Any] | None = None) -> dict:
        path, manifest = CompleteBackup._read(archive, progress)
        return {
            "format": FORMAT,
            "version": VERSION,
            "files": manifest["file_count"],
            "file_count": manifest["file_count"],
            "total_bytes": manifest["total_bytes"],
            "counts": manifest.get("counts", {}),
            "include_media": manifest.get("include_media", False),
            "browser_data_included": "browser-state.json" in manifest["files"],
            "warnings": manifest.get("warnings", []),
        }

    @staticmethod
    def restore(
        archive: Path, destination: Path, progress: Callable[..., Any] | None = None
    ) -> dict:
        archive_path = Path(archive).expanduser()
        destination = Path(destination).expanduser()
        if _is_link(archive_path) or _is_link(destination):
            raise ValueError(
                "Backup archive and restore destination must not be symlinks or junctions"
            )
        archive_path = archive_path.resolve()
        destination = destination.resolve()
        if destination.exists() or destination.is_symlink():
            raise FileExistsError(f"Restore destination already exists: {destination}")
        if _inside(archive_path, destination) or destination == archive_path:
            raise ValueError("Backup archive and restore destination must not overlap")
        _, manifest = CompleteBackup._read(archive_path, progress)
        destination.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(
            tempfile.mkdtemp(prefix=f".{destination.name}.restore-", dir=destination.parent)
        )
        try:
            with zipfile.ZipFile(archive_path, "r") as zf:
                for name in manifest["files"]:
                    target = staging.joinpath(*PurePosixPath(name).parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    copied = 0
                    digest = hashlib.sha256()
                    with zf.open(name) as source, target.open("xb") as sink:
                        while chunk := source.read(CHUNK):
                            sink.write(chunk)
                            digest.update(chunk)
                            copied += len(chunk)
                            _progress(
                                progress,
                                copied,
                                manifest["files"][name]["size"],
                                name,
                                "restore",
                                copied,
                            )
                    record = manifest["files"][name]
                    if copied != record["size"] or digest.hexdigest() != record["sha256"]:
                        raise ValueError(f"Checksum mismatch while extracting: {name}")
            config_filename = manifest.get("config_filename", "config.json")
            _rewrite_restored_paths(
                staging,
                destination,
                manifest.get("portable_paths", {}),
                config_filename,
                manifest.get("media_archive_count", 0),
            )
            _validate_restored_data(staging, destination, config_filename)
            if destination.exists() or destination.is_symlink():
                raise FileExistsError(f"Restore destination already exists: {destination}")
            os.rename(staging, destination)
            staging = None
        finally:
            if staging is not None:
                shutil.rmtree(staging, ignore_errors=True)
        return {
            "format": FORMAT,
            "version": VERSION,
            "destination": str(destination),
            "config_path": str(destination / "appdata" / config_filename),
            "browser_state_path": str(destination / "browser-state.json")
            if "browser-state.json" in manifest["files"]
            else None,
            "file_count": manifest["file_count"],
            "total_bytes": manifest["total_bytes"],
            "warnings": manifest.get("warnings", []),
        }


def _rewrite_paths(value: Any, path_map: dict[str, str], destination: Path, key: str = "") -> Any:
    if isinstance(value, dict):
        return {k: _rewrite_paths(v, path_map, destination, k) for k, v in value.items()}
    if isinstance(value, list):
        return [_rewrite_paths(v, path_map, destination, key) for v in value]
    if isinstance(value, str) and key in {
        "model",
        "recognition_model",
        "identity_gallery",
        "classifier_model",
        "path",
    }:
        mapped = path_map.get(value) or path_map.get(value.replace("\\", "/").casefold())
        if mapped:
            return str(destination.joinpath(*PurePosixPath(mapped).parts))
    return value


def _rewrite_restored_paths(
    root: Path,
    destination: Path,
    portable_paths: dict[str, str] | None = None,
    config_filename: str = "config.json",
    media_archive_count: int = 0,
) -> None:
    path_map = dict(portable_paths or {})
    path_map.update({key.replace("\\", "/").casefold(): value for key, value in path_map.items()})
    storage = root / "appdata" / "storage.json"
    try:
        value = (
            json.loads(storage.read_text(encoding="utf-8"))
            if storage.is_file()
            else {
                "version": 1,
                "media_directory": str(destination / "media"),
                "previous_directories": [],
            }
        )
    except (OSError, ValueError) as error:
        raise ValueError(f"Restored storage settings are invalid: {error}") from error
    if (
        not isinstance(value, dict)
        or set(value) != {"version", "media_directory", "previous_directories"}
        or type(value.get("version")) is not int
        or value["version"] != 1
        or not isinstance(value.get("media_directory"), str)
        or not Path(value["media_directory"]).is_absolute()
        or not isinstance(value.get("previous_directories"), list)
        or len(value["previous_directories"]) > 32
        or any(
            not isinstance(item, str) or not Path(item).is_absolute()
            for item in value["previous_directories"]
        )
    ):
        raise ValueError("Restored storage settings are invalid")
    value["media_directory"] = str(destination / "media")
    value["previous_directories"] = [
        str(destination / "media-archives" / str(index)) for index in range(media_archive_count)
    ]
    storage.parent.mkdir(parents=True, exist_ok=True)
    storage.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    registry = root / "appdata" / "models" / "registry.json"
    if registry.is_file():
        models = json.loads(registry.read_text(encoding="utf-8"))
        for model in models:
            old = model.get("path", "")
            mapped = path_map.get(old) or path_map.get(old.replace("\\", "/").casefold())
            model_path = (
                str(destination.joinpath(*PurePosixPath(mapped).parts))
                if mapped
                else str(destination / "appdata" / "models" / Path(old).name)
            )
            model["path"] = str(model_path)
            if isinstance(model.get("settings"), dict):
                model["settings"]["model"] = str(model_path)
        registry.write_text(json.dumps(models, indent=2) + "\n", encoding="utf-8")
    galleries = root / "appdata" / "face-galleries"
    if galleries.is_dir():
        for catalog_path in galleries.glob("*/*.json"):
            if catalog_path.name not in {"catalog.json", "gallery-v1.json"}:
                continue
            try:
                catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
                catalog = _rewrite_paths(catalog, path_map, destination)
                catalog_path.write_text(
                    json.dumps(catalog, separators=(",", ":")), encoding="utf-8"
                )
            except (OSError, ValueError, TypeError) as error:
                raise ValueError(
                    f"Cannot rewrite face gallery {catalog_path.name}: {error}"
                ) from error
    config = root / "appdata" / config_filename
    if config.is_file():
        data = _rewrite_paths(json.loads(config.read_text(encoding="utf-8")), path_map, destination)
        for camera in data.get("cameras", []) if isinstance(data, dict) else []:
            if isinstance(camera, dict):
                camera["autostart"] = False
        config.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    workflows = root / "appdata" / "workflows.json"
    if workflows.is_file():
        data = json.loads(workflows.read_text(encoding="utf-8"))
        rows = data.get("workflows", []) if isinstance(data, dict) else []
        for row in rows:
            if isinstance(row, dict):
                row["enabled"] = False
        data = _rewrite_paths(data, path_map, destination)
        workflows.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    schedules = root / "appdata" / "schedules.json"
    if schedules.is_file():
        data = json.loads(schedules.read_text(encoding="utf-8"))
        for row in data.get("schedules", []) if isinstance(data, dict) else []:
            if isinstance(row, dict):
                row["enabled"] = False
        schedules.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _validate_restored_data(root: Path, destination: Path, config_filename: str) -> None:
    from spyder_cctv.config import load_app_config
    from spyder_cctv.face_gallery import FaceEnrollmentService
    from spyder_cctv.model_library import ModelLibrary
    from spyder_cctv.recording_allowance import validate_policy
    from spyder_cctv.recording_profiles import validate_settings
    from spyder_cctv.schedules import RecordingSchedules
    from spyder_cctv.workflow import _validate_graph
    from spyder_cctv.workflow_subflows import SubflowCatalog

    config_path = root / "appdata" / config_filename
    if config_path.is_file():
        load_app_config(config_path)
    workflow_path = root / "appdata" / "workflows.json"
    if workflow_path.is_file():
        document = json.loads(workflow_path.read_text(encoding="utf-8"))
        if (
            not isinstance(document, dict)
            or set(document) != {"workflows"}
            or not isinstance(document.get("workflows"), list)
        ):
            raise ValueError("Restored workflows format is invalid")
        for graph in document["workflows"]:
            _validate_graph(graph, allow_bridges=True)
    subflows = root / "appdata" / "subflows.json"
    if subflows.is_file():
        catalog = SubflowCatalog(subflows, lambda raw: _validate_graph(raw, allow_bridges=True))
        if catalog.storage_error:
            raise ValueError(f"Restored subflow catalog is invalid: {catalog.storage_error}")
    schedules = root / "appdata" / "schedules.json"
    if schedules.is_file():
        RecordingSchedules._decode(json.loads(schedules.read_text(encoding="utf-8")))
    events = root / "appdata" / "events" / "events.json"
    if events.is_file():
        event_data = json.loads(events.read_text(encoding="utf-8"))
        if (
            not isinstance(event_data, dict)
            or set(event_data) != {"events"}
            or not isinstance(event_data["events"], list)
        ):
            raise ValueError("Restored events catalog is invalid")
    media = root / "media"
    recording_settings = media / "recording-settings.json"
    if recording_settings.is_file():
        validate_settings(json.loads(recording_settings.read_text(encoding="utf-8")))
    recording_allowance = media / "recording-allowance.json"
    if recording_allowance.is_file():
        validate_policy(json.loads(recording_allowance.read_text(encoding="utf-8")))
    registry_path = root / "appdata" / "models" / "registry.json"

    def staged_file(path: str) -> bool:
        try:
            relative = Path(path).relative_to(destination)
        except ValueError:
            return False
        return root.joinpath(relative).is_file()

    if registry_path.is_file():
        records = json.loads(registry_path.read_text(encoding="utf-8"))
        if (
            not isinstance(records, list)
            or len(records) > 64
            or any(
                not isinstance(row, dict)
                or not ModelLibrary._valid_record(row)
                or not staged_file(row["path"])
                for row in records
            )
            or len({row["id"] for row in records}) != len(records)
        ):
            raise ValueError("Restored model registry or model files are invalid")
    gallery_root = root / "appdata" / "face-galleries"
    if gallery_root.is_dir():
        for catalog_path in gallery_root.glob("*/catalog.json"):
            catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
            FaceEnrollmentService._validate_catalog(catalog, catalog_path.parent.name)
            for key in ("detector", "recognition"):
                path = catalog[key]["path"]
                if not staged_file(path):
                    raise ValueError(
                        f"Restored face gallery model file is missing: {Path(path).name}"
                    )
