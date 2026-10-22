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


def test_retention_run_and_byte_limits(tmp_path: Path):
    store = ExecutionHistory(tmp_path / "history.sqlite")
    store.configure({**store.settings(), "max_runs": 2, "max_bytes": 2048})
    for i in range(6):
        store.record(_run(i, metadata={"text": "x" * 500}))
    assert store.flush()
    result = store.list(size=10)
    assert result["total"] <= 2
    assert result["stats"]["data_bytes"] <= 2048
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
