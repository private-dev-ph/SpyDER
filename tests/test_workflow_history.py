from __future__ import annotations

import queue
import threading
from datetime import UTC, datetime
from pathlib import Path

import pytest

from spyder_cctv.workflow_history import ExecutionHistory


def _run(index: int, **kwargs):
    return {
        "id": f"run-{index}",
        "workflow_id": "wf-1",
        "name": f"Workflow {index}",
        "camera_id": "cam-1",
        "started_at": (datetime.now(UTC)).isoformat(),
        "duration_ms": 12,
        "state": "completed",
        "source": "live",
        "graph_revision": "rev-a",
        "graph": {"nodes": [{"id": "n1", "type": "camera"}]},
        "nodes": [
            {
                "id": "n1",
                "type": "camera",
                "state": "ok",
                "input_count": 0,
                "output_count": 1,
                "duration_ms": 2,
            }
        ],
        **kwargs,
    }


def test_persistence_search_filters_and_pagination(tmp_path: Path):
    path = tmp_path / "history.sqlite"
    store = ExecutionHistory(path)
    for i in range(4):
        assert store.record(_run(i)) == f"run-{i}"
    assert store.flush()
    result = store.list(
        query="Workflow", workflow_id="wf-1", camera_id="cam-1", state="completed", page=0, size=2
    )
    assert result["total"] == 4
    assert result["pages"] == 2
    assert len(result["runs"]) == 2
    full = store.get("run-3")
    assert full["graph"] == {"nodes": [{"id": "n1", "type": "camera"}]}
    store.close()

    reopened = ExecutionHistory(path)
    assert reopened.get("run-3")["workflow_id"] == "wf-1"
    reopened.close()


def test_per_workflow_history_policy_disabled_states_interval_and_error_override(tmp_path: Path):
    store = ExecutionHistory(tmp_path / "policy.sqlite")
    policy = {
        "enabled": True,
        "states": ["completed", "error"],
        "min_interval_seconds": 3600,
        "always_save_errors": True,
    }
    disabled = {**_run(0), "graph": {"history": {**policy, "enabled": False}}}
    assert store.record(disabled) is None
    filtered = {**_run(1), "state": "filtered", "graph": {"history": policy}}
    assert store.record(filtered) is None

    first = {**_run(2), "graph": {"history": policy}}
    assert store.record(first) == "run-2"
    # Interval applies across cameras for same workflow.
    other_camera = {
        **_run(3),
        "camera_id": "cam-2",
        "graph": {"history": policy},
    }
    assert store.record(other_camera) is None
    error = {**_run(4), "state": "error", "graph": {"history": policy}}
    assert store.record(error) == "run-4"
    reject_errors = {
        **policy,
        "always_save_errors": False,
    }
    assert store.record({**_run(5), "state": "error", "graph": {"history": reject_errors}}) is None
    store.close()


def test_history_rate_window_updates_only_after_queue_acceptance(tmp_path: Path, monkeypatch):
    store = ExecutionHistory(tmp_path / "queue-policy.sqlite")
    policy = {
        "enabled": True,
        "states": ["completed"],
        "min_interval_seconds": 3600,
        "always_save_errors": True,
    }
    original_put = store._queue.put_nowait

    def full(_item):
        raise queue.Full

    monkeypatch.setattr(store._queue, "put_nowait", full)
    assert store.record({**_run(1), "graph": {"history": policy}}) is None
    assert store.dropped == 1
    assert not store._workflow_record_times
    monkeypatch.setattr(store._queue, "put_nowait", original_put)
    assert store.record({**_run(2), "graph": {"history": policy}}) == "run-2"
    assert store._workflow_record_times["wf-1"] > 0
    store.close()


def test_history_overview_source_sort_and_page_clamp(tmp_path: Path):
    store = ExecutionHistory(tmp_path / "history.sqlite")
    date = datetime.now(UTC).replace(hour=12, minute=0, second=0, microsecond=0)
    for index, state, duration in (
        (1, "completed", 10),
        (2, "filtered", 40),
        (3, "error", 20),
    ):
        store.record(
            _run(
                index,
                state=state,
                duration_ms=duration,
                started_at=date.replace(minute=index).isoformat(),
            )
        )
    assert store.flush()
    result = store.list(
        source="live",
        since=date.date().isoformat(),
        until=date.date().isoformat(),
        sort="slowest",
        page=8,
    )
    assert [run["id"] for run in result["runs"]] == ["run-2", "run-3", "run-1"]
    assert result["page"] == 0
    assert result["overview"] == {
        "completed": 1,
        "filtered": 1,
        "error": 1,
        "average_duration_ms": 23.333,
    }
    assert store.list(sort="oldest", size=1)["runs"][0]["id"] == "run-1"
    with pytest.raises(ValueError, match="sort"):
        store.list(sort="duration")
    with pytest.raises(ValueError, match="source"):
        store.list(source="worker")
    store.close()


def test_search_escapes_sql_wildcards(tmp_path: Path):
    store = ExecutionHistory(tmp_path / "history.sqlite")
    store.record(_run(1, name="100% real"))
    store.record(_run(2, name="1000 real"))
    assert store.flush()
    assert store.list(query="%")["total"] == 1
    store.close()


def test_diagnostic_bounds_and_sensitive_values_stripped(tmp_path: Path):
    store = ExecutionHistory(tmp_path / "history.sqlite")
    store.configure({**store.settings(), "mode": "diagnostic"})
    store.record(
        _run(
            1,
            nodes=[
                {
                    "id": "n",
                    "inputs": {"image": "secret", "count": 3},
                    "outputs": {"embedding": [1, 2], "result": "ok"},
                }
            ],
        )
    )
    assert store.flush()
    node = store.get("run-1")["nodes"][0]
    assert node["inputs"] == {"count": 3}
    assert node["outputs"] == {"result": "ok"}
    store.close()


def test_graphs_deduplicate_and_node_path_survives_summary_mode(tmp_path: Path):
    store = ExecutionHistory(tmp_path / "history.sqlite")
    graph = {
        "nodes": [{"id": "n", "type": "subflow", "source": "x" * 2000}],
        "edges": [{"source": "a", "target": "b"}],
    }
    for index in range(2):
        store.record(
            _run(
                index,
                graph=graph,
                nodes=[{"id": "n", "type": "subflow", "path": ["outer", "inner"]}],
            )
        )
    assert store.flush()
    assert store.get("run-0")["nodes"][0]["path"] == ["outer", "inner"]
    assert store.get("run-0")["graph"] == graph
    with store._lock:
        assert store._db.execute("SELECT count(*) FROM graphs").fetchone()[0] == 1
    store.close()


def test_storage_failure_does_not_abort_startup_or_inference(tmp_path: Path):
    directory = tmp_path / "is-a-directory.sqlite"
    directory.mkdir()
    store = ExecutionHistory(directory)
    assert store.error
    assert store.record(_run(1)) is None
    with pytest.raises(RuntimeError):
        store.configure(store.settings())
    store.close()


def test_record_does_not_wait_for_reader_database_lock(tmp_path: Path):
    store = ExecutionHistory(tmp_path / "history.sqlite")
    store._lock.acquire()
    try:
        assert store.record(_run(1)) == "run-1"
    finally:
        store._lock.release()
    assert store.flush()
    store.close()


def test_graph_preserves_large_nested_path_maps_and_code(tmp_path: Path):
    store = ExecutionHistory(tmp_path / "history.sqlite")
    paths = {f"node-{index}": ["nested"] for index in range(100)}
    code = "x" * 12_000
    graph = {
        "_paths": paths,
        "nodes": [{"id": "n", "params": {"bindings": {"deep": {"again": {"source": code}}}}}],
    }
    store.record(_run(1, graph=graph))
    assert store.flush()
    restored = store.get("run-1")["graph"]
    assert len(restored["_paths"]) == 100
    assert restored["nodes"][0]["params"]["bindings"]["deep"]["again"]["source"] == code
    store.close()


def test_summary_drops_signal_payload_but_keeps_trace_fields(tmp_path: Path):
    store = ExecutionHistory(tmp_path / "history.sqlite")
    store.record(
        _run(
            1,
            nodes=[
                {
                    "id": "n",
                    "type": "filter",
                    "state": "ok",
                    "path": ["outer", "inner"],
                    "signals": {"identity": "private person", "count": 2},
                    "identity": "private person",
                }
            ],
        )
    )
    assert store.flush()
    node = store.get("run-1")["nodes"][0]
    assert node["path"] == ["outer", "inner"]
    assert "signals" not in node
    assert "identity" not in node
    store.close()


def test_settings_report_success_only_after_commit(tmp_path: Path):
    store = ExecutionHistory(tmp_path / "history.sqlite")
    assert store.flush()
    with store._lock:
        store._db.execute(
            "CREATE TRIGGER reject_settings BEFORE INSERT ON settings "
            "BEGIN SELECT RAISE(ABORT, 'forced settings failure'); END"
        )
        store._db.commit()
    original = store.settings()
    with pytest.raises(RuntimeError, match="forced settings failure"):
        store.configure({**original, "mode": "diagnostic"})
    assert store.settings() == original
    store.close()


def test_close_racing_record_does_not_leave_writer_queue_hung(tmp_path: Path):
    store = ExecutionHistory(tmp_path / "history.sqlite")
    started = threading.Event()

    def produce():
        for index in range(300):
            store.record(_run(index))
            started.set()

    thread = threading.Thread(target=produce)
    thread.start()
    assert started.wait(1)
    store.close()
    thread.join(timeout=2)
    assert not thread.is_alive()
    assert store.record(_run(999)) is None


def test_retention_run_and_byte_limits(tmp_path: Path):
    store = ExecutionHistory(tmp_path / "history.sqlite")
    store.configure({**store.settings(), "max_runs": 2, "max_bytes": 1024 * 1024})
    for i in range(6):
        store.record(_run(i, metadata={"text": "x" * 500}))
    assert store.flush()
    result = store.list(size=10)
    assert result["total"] <= 2
    assert result["stats"]["data_bytes"] <= 1024 * 1024
    store.close()
    assert (tmp_path / "history.sqlite").stat().st_size < 100_000


def test_settings_validation_and_persistence(tmp_path: Path):
    path = tmp_path / "history.sqlite"
    store = ExecutionHistory(path)
    with pytest.raises(ValueError):
        store.configure({**store.settings(), "max_runs": True})
    with pytest.raises(ValueError):
        store.configure({**store.settings(), "mode": "full"})
    updated = {**store.settings(), "retention_days": 3, "enabled": False}
    store.configure(updated)
    store.close()
    reopened = ExecutionHistory(path)
    assert reopened.settings()["retention_days"] == 3
    assert reopened.settings()["enabled"] is False
    assert reopened.record(_run(1)) is None
    reopened.close()


def test_queue_backpressure_is_nonblocking_and_counted(tmp_path: Path):
    store = ExecutionHistory(tmp_path / "history.sqlite")

    class FullQueue:
        def put_nowait(self, item):
            raise queue.Full

    original = store._queue
    store._queue = FullQueue()
    assert store.record(_run(1)) is None
    assert store.dropped == 1
    store._queue = original
    store.close()


def test_reader_and_writer_can_run_concurrently(tmp_path: Path):
    store = ExecutionHistory(tmp_path / "history.sqlite")
    failures: list[BaseException] = []

    def produce():
        try:
            for index in range(100):
                store.record(_run(index))
        except BaseException as exc:  # pragma: no cover - assertion reports worker failure
            failures.append(exc)

    thread = threading.Thread(target=produce)
    thread.start()
    while thread.is_alive():
        store.list(size=10)
    thread.join()
    assert not failures
    assert store.flush()
    assert store.list(size=200)["total"] > 0
    store.close()


def test_delete_clear_and_flush_close(tmp_path: Path):
    store = ExecutionHistory(tmp_path / "history.sqlite")
    for i in range(3):
        store.record(_run(i))
    assert store.flush()
    assert store.delete(["run-0", "missing"]) == 1
    assert store.clear() == 2
    assert store.list()["total"] == 0
    store.close()


def test_oversized_graph_marks_snapshot_incomplete_instead_of_silent_partial_replay(tmp_path):
    history = ExecutionHistory(tmp_path / "history.sqlite3")
    try:
        identifier = history.record(
            {
                "workflow_id": "large",
                "graph": {
                    "nodes": [{"id": str(i), "params": {"source": "x" * 8000}} for i in range(100)],
                    "edges": [],
                },
                "nodes": [],
            }
        )
        assert identifier
        assert history.flush()
        result = history.get(identifier)
        assert result["graph_complete"] is False
        assert result["snapshot_warning"]
        assert result["graph"]["nodes"] == []
    finally:
        history.close()


def test_duration_index_migrates_existing_history_and_preserves_fractional_timings(tmp_path):
    import sqlite3

    path = tmp_path / "old.sqlite"
    store = ExecutionHistory(path)
    assert store.record(_run(1, duration_ms=0.375))
    assert store.flush()
    store.close()
    with sqlite3.connect(path) as db:
        db.execute("DROP INDEX runs_duration_idx")
        db.execute("ALTER TABLE runs DROP COLUMN duration_ms")
    store = ExecutionHistory(path)
    try:
        result = store.list(sort="slowest")
        assert result["runs"][0]["duration_ms"] == 0.375
        assert result["overview"]["average_duration_ms"] == 0.375
        assert store.record(_run(2, duration_ms=1.5, started_at=datetime.now(UTC).isoformat()))
        assert store.flush()
        assert store.list(sort="slowest")["runs"][0]["id"] == "run-2"
    finally:
        store.close()
