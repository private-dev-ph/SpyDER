"""Tests for bounded full backup job coordination and request validation."""

import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from spyder_cctv import backup_jobs
from spyder_cctv.backup_jobs import BackupJobs, validate_job_request


class _ArchiveStub:
    started = threading.Event()
    release = threading.Event()

    @classmethod
    def inspect(cls, archive, progress=None):
        cls.started.set()
        cls.release.wait(2)
        progress({"phase": "scan", "files": 3, "bytes": 24, "message": "Scanning\narchive"})
        return {"format": "spyder-fullbackup", "version": 1, "files": 3, "total_bytes": 24}


@pytest.fixture(autouse=True)
def _reset_archive(monkeypatch):
    _ArchiveStub.started.clear()
    _ArchiveStub.release.clear()
    monkeypatch.setattr(backup_jobs, "_complete_backup", lambda: _ArchiveStub)


def _jobs():
    return BackupJobs(SimpleNamespace(), SimpleNamespace(), SimpleNamespace(), SimpleNamespace())


def test_job_runs_in_background_and_exposes_bounded_progress():
    jobs = _jobs()
    initial = jobs.start("inspect", Path("C:/backup.spyder"))
    assert initial["state"] == "running"
    assert _ArchiveStub.started.wait(1)
    assert jobs.snapshot()["state"] == "running"
    with pytest.raises(RuntimeError, match="already running"):
        jobs.start("inspect", Path("C:/other.spyder"))
    _ArchiveStub.release.set()
    deadline = time.monotonic() + 2
    while jobs.snapshot()["state"] == "running" and time.monotonic() < deadline:
        time.sleep(0.01)
    status = jobs.snapshot()
    assert status["state"] == "completed"
    assert status["progress"]["message"] == "Completed"
    assert status["result"] == {
        "format": "spyder-fullbackup", "version": 1, "files": 3, "total_bytes": 24
    }


def test_job_error_is_bounded(monkeypatch):
    class BadArchive:
        @staticmethod
        def inspect(archive, progress=None):
            raise RuntimeError("x" * 500)

    monkeypatch.setattr(backup_jobs, "_complete_backup", lambda: BadArchive)
    jobs = _jobs()
    jobs.start("inspect", Path("C:/backup.spyder"))
    deadline = time.monotonic() + 2
    while jobs.snapshot()["state"] == "running" and time.monotonic() < deadline:
        time.sleep(0.01)
    assert jobs.snapshot()["state"] == "error"
    assert len(jobs.snapshot()["error"]) <= 240


def test_request_validation_requires_absolute_paths_and_new_restore_folder(tmp_path):
    with pytest.raises(ValueError, match="absolute"):
        validate_job_request({"operation": "inspect", "path": "backup.spyder"})
    existing = tmp_path / "existing"
    existing.mkdir()
    with pytest.raises(ValueError, match="new folder"):
        validate_job_request({
            "operation": "restore",
            "path": str(tmp_path / "archive.spyder"),
            "destination": str(existing),
        })


def test_request_validation_rejects_create_only_fields_on_inspect(tmp_path):
    with pytest.raises(ValueError, match="only valid for create"):
        validate_job_request({
            "operation": "inspect", "path": str(tmp_path / "archive.spyder"), "include_media": True
        })
    with pytest.raises(ValueError, match="only valid for create"):
        validate_job_request({
            "operation": "inspect", "path": str(tmp_path / "archive.spyder"), "browser_data": {}
        })
