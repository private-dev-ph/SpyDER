"""Bounded, local-only persistence for workflow execution history."""

from __future__ import annotations

import hashlib
import json
import queue
import sqlite3
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

_DEFAULTS: dict[str, Any] = {
    "enabled": True,
    "mode": "summary",
    "retention_days": 7,
    "max_runs": 10_000,
    "max_bytes": 64 * 1024 * 1024,
}
_MAX_QUEUE = 256
_MAX_RUN_BYTES = 512 * 1024
_MAX_NODES = 256
_MAX_DEPTH = 8
_MAX_TEXT = 4096
_SECRET_KEYS = {
    "frame",
    "image",
    "frames",
    "embedding",
    "embeddings",
    "base64",
    "weights",
    "weight",
    "tensor",
    "pixels",
    "raw_data",
    "blob",
}
_GRAPH_SECRET_KEYS = _SECRET_KEYS | {"frame_data", "image_data", "raw_frame", "raw_image"}
_STATUSES = {"completed", "filtered", "error"}


def _clean(value: Any, *, diagnostic: bool, depth: int = 0, key: str = "") -> Any:
    """Convert supported metadata to bounded JSON-safe values."""
    if key.lower() in _SECRET_KEYS:
        return None
    if depth > _MAX_DEPTH:
        return "[truncated]"
    if value is None or type(value) in (bool, int, float):
        return value if not isinstance(value, float) or abs(value) < 1e100 else str(value)
    if isinstance(value, str):
        return value[:_MAX_TEXT] if diagnostic else value[:512]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for index, (child_key, child) in enumerate(value.items()):
            if index >= 64:
                break
            if not isinstance(child_key, str):
                continue
            cleaned = _clean(child, diagnostic=diagnostic, depth=depth + 1, key=child_key)
            if cleaned is not None:
                out[child_key[:128]] = cleaned
        return out
    if isinstance(value, (list, tuple)):
        return [
            _clean(item, diagnostic=diagnostic, depth=depth + 1)
            for item in value[: 512 if diagnostic or key in ("nodes", "actions") else 128]
        ]
    # Never call arbitrary serializers (including numpy or model object hooks).
    return None


class ExecutionHistory:
    """SQLite execution store with a bounded, nonblocking producer queue."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._queue: queue.Queue[tuple[str, Any]] = queue.Queue(maxsize=_MAX_QUEUE)
        self._lock = threading.RLock()
        self._state_lock = threading.RLock()
        self._closed = False
        self.dropped = 0
        self.error: str | None = None
        self._available = True
        self._settings = dict(_DEFAULTS)
        self._last_compact = time.monotonic()
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._db = sqlite3.connect(self.path, timeout=2, check_same_thread=False)
        except Exception as exc:
            self.error = f"Workflow history storage unavailable: {exc}"[:512]
            self._available = False
            self._db = sqlite3.connect(":memory:", check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        if self._available:
            try:
                self._db.execute("PRAGMA journal_mode=WAL")
                self._db.execute("PRAGMA synchronous=NORMAL")
                self._db.execute("PRAGMA auto_vacuum=INCREMENTAL")
            except sqlite3.Error as exc:
                self.error = f"Workflow history storage unavailable: {exc}"[:512]
                self._available = False
        try:
            self._db.executescript(
                """CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, camera_id TEXT NOT NULL,
                started_at TEXT NOT NULL, state TEXT NOT NULL, name TEXT NOT NULL,
                source TEXT NOT NULL, summary_json TEXT NOT NULL, detail_json TEXT NOT NULL,
                graph_json TEXT NOT NULL DEFAULT '{}', size_bytes INTEGER NOT NULL,
                graph_revision TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS graphs(
                revision TEXT PRIMARY KEY, graph_json TEXT NOT NULL, size_bytes INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS runs_time_idx ON runs(started_at DESC, id);
            CREATE INDEX IF NOT EXISTS runs_workflow_idx ON runs(workflow_id, started_at DESC);
            CREATE INDEX IF NOT EXISTS runs_camera_idx ON runs(camera_id, started_at DESC);
            CREATE INDEX IF NOT EXISTS runs_state_idx ON runs(state, started_at DESC);
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);"""
            )
        except sqlite3.Error as exc:
            self.error = f"Workflow history storage unavailable: {exc}"[:512]
            self._available = False
            try:
                self._db.close()
            except sqlite3.Error:
                pass
            self._db = sqlite3.connect(":memory:", check_same_thread=False)
            self._db.row_factory = sqlite3.Row
            self._db.executescript(
                """CREATE TABLE runs(id TEXT PRIMARY KEY, workflow_id TEXT, camera_id TEXT,
                started_at TEXT, state TEXT, name TEXT, source TEXT, summary_json TEXT,
                detail_json TEXT, graph_json TEXT, size_bytes INTEGER, graph_revision TEXT);
                CREATE TABLE graphs(revision TEXT PRIMARY KEY, graph_json TEXT, size_bytes INTEGER);
                CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);"""
            )
        columns = {row[1] for row in self._db.execute("PRAGMA table_info(runs)")}
        if "graph_revision" not in columns:
            self._db.execute("ALTER TABLE runs ADD COLUMN graph_revision TEXT NOT NULL DEFAULT ''")
        self._db.commit()
        saved = dict(self._db.execute("SELECT key, value FROM settings").fetchall())
        try:
            self._settings.update(
                {key: json.loads(value) for key, value in saved.items() if key in _DEFAULTS}
            )
            self._settings = self._validate_settings(self._settings)
        except (ValueError, TypeError):
            self._settings = dict(_DEFAULTS)
        if self._available:
            self._db.execute("PRAGMA journal_size_limit=1048576")
            self._db.execute("PRAGMA wal_autocheckpoint=64")
            self._set_page_limit_locked()
        self._writer = threading.Thread(
            target=self._write_loop, name="workflow-history", daemon=True
        )
        self._writer.start()

    @staticmethod
    def _validate_settings(raw: dict[str, Any]) -> dict[str, Any]:
        if set(raw) != set(_DEFAULTS):
            raise ValueError(
                "Settings must include enabled, mode, retention_days, max_runs, max_bytes"
            )
        if type(raw["enabled"]) is not bool:
            raise ValueError("enabled must be a boolean")
        if raw["mode"] not in ("summary", "diagnostic"):
            raise ValueError("mode must be summary or diagnostic")
        result = dict(raw)
        for key, low, high in (
            ("retention_days", 1, 3650),
            ("max_runs", 1, 1_000_000),
            ("max_bytes", 1024 * 1024, 2**31),
        ):
            value = raw[key]
            if type(value) is not int or not low <= value <= high:
                raise ValueError(f"{key} must be an integer from {low} to {high}")
        return result

    def settings(self) -> dict[str, Any]:
        with self._state_lock:
            return dict(self._settings)

    def configure(self, raw: dict[str, Any]) -> dict[str, Any]:
        settings = self._validate_settings(raw)
        if not self._available:
            raise RuntimeError(self.error or "Workflow history storage unavailable")
        try:
            self._call("settings", settings)
        except Exception as exc:
            raise RuntimeError(f"Cannot persist workflow history settings: {exc}") from exc
        return dict(settings)

    def record(self, run: dict[str, Any]) -> str | None:
        """Queue run safely. Return identifier when accepted; never raise to inference caller."""
        try:
            with self._state_lock:
                if self._closed or not self._settings["enabled"]:
                    return None
                diagnostic = self._settings["mode"] == "diagnostic"
            if not isinstance(run, dict):
                return None
            identifier = str(run.get("id") or uuid.uuid4())[:64]
            started = str(run.get("started_at") or datetime.now(UTC).isoformat())[:64]
            nodes = run.get("nodes", [])
            if not isinstance(nodes, list):
                nodes = []
            nodes = nodes[:_MAX_NODES]
            raw_graph = run.get("graph", {})
            graph_complete = True
            try:
                graph_json = json.dumps(
                    raw_graph,
                    allow_nan=False,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                if len(graph_json.encode("utf-8")) > _MAX_RUN_BYTES:
                    raise ValueError("Graph exceeds snapshot allowance")
            except (TypeError, ValueError, OverflowError):
                graph_complete = False
                graph_json = json.dumps(
                    {"id": str(run.get("workflow_id", ""))[:128], "nodes": [], "edges": []}
                )
            graph_revision = hashlib.sha256(graph_json.encode("utf-8")).hexdigest()[:32]
            details = _clean(
                {
                    "nodes": nodes,
                    "model_refs": run.get("model_refs", []),
                    "actions": run.get("actions", []),
                    "context": run.get("context", {}) if diagnostic else {},
                    "metadata": run.get("metadata", {}),
                },
                diagnostic=diagnostic,
            )
            if diagnostic and isinstance(details.get("context"), dict):
                try:
                    original_context = json.dumps(
                        run.get("context", {}), allow_nan=False, sort_keys=True
                    )
                    retained_context = json.dumps(
                        details["context"], allow_nan=False, sort_keys=True
                    )
                    if original_context != retained_context:
                        details["context"]["inputs_truncated"] = True
                except (TypeError, ValueError):
                    details["context"]["inputs_truncated"] = True
            if not diagnostic:
                allowed_node_fields = {
                    "id",
                    "type",
                    "state",
                    "input_count",
                    "output_count",
                    "duration_ms",
                    "error",
                    "path",
                    "signal_count",
                    "signals_count",
                }
                details = {
                    "nodes": [
                        {k: v for k, v in node.items() if k in allowed_node_fields}
                        for node in details["nodes"]
                        if isinstance(node, dict)
                    ],
                    "model_refs": details["model_refs"],
                    "actions": [
                        {
                            key: action[key]
                            for key in (
                                "id",
                                "node_id",
                                "event_id",
                                "type",
                                "state",
                                "status",
                                "media_ref",
                                "media_id",
                                "media",
                                "attachment_state",
                                "attachment_error",
                            )
                            if key in action
                        }
                        for action in details["actions"]
                        if isinstance(action, dict)
                    ],
                }
            state = str(run.get("state", "completed"))
            if state not in _STATUSES:
                state = "error" if state.lower() == "error" else "completed"
            summary = {
                "id": identifier,
                "workflow_id": str(run.get("workflow_id", ""))[:128],
                "name": str(run.get("name", ""))[:256],
                "camera_id": str(run.get("camera_id", ""))[:128],
                "started_at": started,
                "duration_ms": max(0, min(int(run.get("duration_ms", 0) or 0), 2**31 - 1)),
                "state": state,
                "source": str(run.get("source", "live"))[:32],
                "sequence": _clean(run.get("sequence"), diagnostic=diagnostic),
                "graph_complete": graph_complete,
                "snapshot_warning": ""
                if graph_complete
                else (
                    "Configuration snapshot exceeded its allowance or could not be serialized. "
                    "Replay is unavailable."
                ),
            }
            summary["graph_revision"] = graph_revision
            payload = (summary, details)
            encoded_size = len(
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            )
            while (
                encoded_size > _MAX_RUN_BYTES
                and isinstance(details.get("nodes"), list)
                and details["nodes"]
            ):
                details["nodes"].pop()
                encoded_size = len(
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                )
            summary["trace_complete"] = len(details.get("nodes", [])) == len(nodes)
            if not summary["trace_complete"]:
                summary["snapshot_warning"] += (
                    " Some node details exceeded the retention allowance."
                )
            encoded_size = len(
                json.dumps((summary, details), ensure_ascii=False, separators=(",", ":")).encode(
                    "utf-8"
                )
            )
            if encoded_size > _MAX_RUN_BYTES:
                with self._state_lock:
                    self.dropped += 1
                return None
            if not self._available:
                return None
            with self._state_lock:
                if self._closed or not self._settings["enabled"]:
                    return None
                self._queue.put_nowait(("record", (summary, details, graph_json, encoded_size)))
            return identifier
        except Exception:
            with self._state_lock:
                self.dropped += 1
            return None

    def annotate(self, run_id: str, patch: dict[str, Any]) -> bool:
        """Queue bounded outcome metadata update."""
        try:
            with self._state_lock:
                if self._closed:
                    return False
                self._queue.put_nowait(
                    ("annotate", (str(run_id)[:64], _clean(patch, diagnostic=True)))
                )
            return True
        except Exception:
            with self._state_lock:
                self.dropped += 1
            return False

    def list(
        self,
        query: str = "",
        workflow_id: str = "",
        camera_id: str = "",
        state: str = "",
        since: str = "",
        until: str = "",
        page: int = 0,
        size: int = 25,
    ) -> dict[str, Any]:
        page = max(0, min(int(page), 1_000_000))
        size = max(1, min(int(size), 200))
        clauses: list[str] = []
        args: list[Any] = []
        for column, value in (
            ("workflow_id", workflow_id),
            ("camera_id", camera_id),
            ("state", state),
        ):
            if value:
                clauses.append(f"{column}=?")
                args.append(str(value)[:256])
        if since:
            clauses.append("started_at>=?")
            args.append(str(since)[:64])
        if until:
            clauses.append("started_at<=?")
            args.append(str(until)[:64])
        if query:
            escaped = str(query)[:128].replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            clauses.append(
                "(name LIKE ? ESCAPE '\\' OR workflow_id LIKE ? ESCAPE '\\' "
                "OR camera_id LIKE ? ESCAPE '\\')"
            )
            args.extend([f"%{escaped}%"] * 3)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with self._lock:
            total = self._db.execute("SELECT count(*) FROM runs" + where, args).fetchone()[0]
            rows = self._db.execute(
                "SELECT summary_json FROM runs"
                + where
                + " ORDER BY started_at DESC, id LIMIT ? OFFSET ?",
                [*args, size, page * size],
            ).fetchall()
            stats = self._stats_locked()
            settings = dict(self._settings)
        pages = (total + size - 1) // size
        return {
            "runs": [json.loads(row[0]) for row in rows],
            "total": total,
            "page": page,
            "pages": pages,
            "size": size,
            "settings": settings,
            "stats": stats,
        }

    def get(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT summary_json, detail_json, graphs.graph_json FROM runs "
                "LEFT JOIN graphs ON runs.graph_revision=graphs.revision WHERE runs.id=?",
                (str(run_id)[:64],),
            ).fetchone()
        if row is None:
            return None
        return {**json.loads(row[0]), **json.loads(row[1]), "graph": json.loads(row[2] or "{}")}

    def delete(self, ids: list[str]) -> int:
        if not isinstance(ids, list) or len(ids) > 500:
            raise ValueError("delete accepts at most 500 run IDs")
        return int(self._call("delete", [str(item)[:64] for item in ids]))

    def clear(self) -> int:
        return int(self._call("clear", None))

    def flush(self, timeout: float = 5.0) -> bool:
        with self._state_lock:
            if self._closed:
                return not self._writer.is_alive()
            event = threading.Event()
            try:
                self._queue.put(("flush", event), timeout=max(0, timeout))
            except queue.Full:
                return False
        return event.wait(max(0, timeout)) and self.error is None

    def close(self) -> None:
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
        flushed = threading.Event()
        try:
            self._queue.put(("flush", flushed), timeout=2)
            flushed.wait(10)
        except queue.Full:
            pass
        try:
            self._queue.put(("stop", None), timeout=10)
        except queue.Full:
            self.error = self.error or "Workflow history writer queue did not drain during close"
        self._writer.join(timeout=10)
        with self._lock:
            try:
                if self._available and not self._writer.is_alive():
                    self._db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                    self._db.execute("PRAGMA incremental_vacuum")
            except sqlite3.Error as exc:
                self.error = str(exc)
            if not self._writer.is_alive():
                self._db.close()

    def _call(self, operation: str, value: Any) -> Any:
        event = threading.Event()
        box: list[Any] = []
        with self._state_lock:
            if self._closed:
                raise RuntimeError("Workflow history is closed")
            self._queue.put((operation, (value, event, box)), timeout=2)
        if not event.wait(5):
            raise TimeoutError("workflow history writer did not respond")
        if box and isinstance(box[0], Exception):
            raise box[0]
        return box[0] if box else None

    def _write_loop(self) -> None:
        pending: list[tuple[str, Any]] = []
        stopping = False
        while not stopping:
            item = self._queue.get()
            pending.append(item)
            deadline = time.monotonic() + 0.05
            while len(pending) < 64 and time.monotonic() < deadline:
                try:
                    pending.append(self._queue.get_nowait())
                except queue.Empty:
                    time.sleep(0.001)
            with self._lock:
                try:
                    acknowledgements: list[tuple[str, Any]] = []
                    configured: dict[str, Any] | None = None
                    for operation, payload in pending:
                        if operation == "record":
                            summary, details, graph, size = payload
                            revision = summary["graph_revision"]
                            self._db.execute(
                                "INSERT OR IGNORE INTO graphs(revision,graph_json,size_bytes) "
                                "VALUES(?,?,?)",
                                (revision, graph, len(graph.encode("utf-8"))),
                            )
                            self._db.execute(
                                "INSERT OR REPLACE INTO runs(id,workflow_id,camera_id,started_at,"
                                "state,name,source,summary_json,detail_json,graph_json,size_bytes,"
                                "graph_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                                (
                                    summary["id"],
                                    summary["workflow_id"],
                                    summary["camera_id"],
                                    summary["started_at"],
                                    summary["state"],
                                    summary["name"],
                                    summary["source"],
                                    json.dumps(summary, separators=(",", ":")),
                                    json.dumps(details, separators=(",", ":")),
                                    "{}",
                                    size,
                                    revision,
                                ),
                            )
                        elif operation == "annotate":
                            run_id, patch = payload
                            row = self._db.execute(
                                "SELECT detail_json FROM runs WHERE id=?", (run_id,)
                            ).fetchone()
                            if row:
                                detail = json.loads(row[0])
                                detail["outcome"] = patch
                                encoded = json.dumps(detail, separators=(",", ":"))
                                self._db.execute(
                                    "UPDATE runs SET detail_json=?,size_bytes=size_bytes+? "
                                    "WHERE id=?",
                                    (
                                        encoded,
                                        max(0, len(encoded.encode()) - len(row[0].encode())),
                                        run_id,
                                    ),
                                )
                        elif operation == "settings":
                            values, event, box = payload
                            for key, value in values.items():
                                self._db.execute(
                                    "INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",
                                    (key, json.dumps(value)),
                                )
                            configured = dict(values)
                            acknowledgements.append((operation, payload))
                        elif operation == "delete":
                            before = self._db.total_changes
                            self._db.executemany(
                                "DELETE FROM runs WHERE id=?", [(item,) for item in payload[0]]
                            )
                            acknowledgements.append(
                                (operation, (payload, self._db.total_changes - before))
                            )
                        elif operation == "clear":
                            count = self._db.execute("SELECT count(*) FROM runs").fetchone()[0]
                            self._db.execute("DELETE FROM runs")
                            acknowledgements.append((operation, (payload, count)))
                        elif operation == "flush":
                            pass
                        elif operation == "stop":
                            stopping = True
                    self._cleanup_locked(configured)
                    self._set_page_limit_locked(configured)
                    self._db.commit()
                    if self._available:
                        self.error = None
                    self._db.execute("PRAGMA wal_checkpoint(PASSIVE)")
                    if configured is not None or time.monotonic() - self._last_compact >= 30:
                        self._db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                        self._db.execute("PRAGMA incremental_vacuum")
                        self._db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                        self._last_compact = time.monotonic()
                    if configured is not None:
                        with self._state_lock:
                            self._settings = configured
                    for operation, acknowledgement in acknowledgements:
                        if operation == "settings":
                            values, event, box = acknowledgement
                            box.append(dict(values))
                            event.set()
                        else:
                            payload, result = acknowledgement
                            payload[2].append(result)
                            payload[1].set()
                except Exception as exc:
                    self.error = str(exc)[:512]
                    self.dropped += sum(op == "record" for op, _ in pending)
                    self._db.rollback()
                    for operation, payload in pending:
                        if operation == "delete":
                            payload[2].append(exc)
                            payload[1].set()
                        elif operation == "clear":
                            payload[2].append(exc)
                            payload[1].set()
                        elif operation == "settings":
                            payload[2].append(exc)
                            payload[1].set()
                for operation, payload in pending:
                    if operation == "flush":
                        payload.set()
                    elif operation == "stop":
                        stopping = True
                pending.clear()

    def _cleanup_locked(self, settings: dict[str, Any] | None = None) -> None:
        settings = settings or self._settings
        cutoff = (datetime.now(UTC) - timedelta(days=settings["retention_days"])).isoformat()
        self._db.execute("DELETE FROM runs WHERE started_at < ?", (cutoff,))
        excess = self._db.execute(
            "SELECT count(*) - ? FROM runs", (settings["max_runs"],)
        ).fetchone()[0]
        if excess > 0:
            self._db.execute(
                "DELETE FROM runs WHERE id IN "
                "(SELECT id FROM runs ORDER BY started_at ASC LIMIT ?)",
                (excess,),
            )
        self._db.execute(
            "DELETE FROM graphs WHERE revision NOT IN (SELECT DISTINCT graph_revision FROM runs)"
        )
        total_bytes = self._db.execute(
            "SELECT (SELECT coalesce(sum(size_bytes),0) FROM runs) + "
            "(SELECT coalesce(sum(size_bytes),0) FROM graphs)"
        ).fetchone()[0]
        budget = settings["max_bytes"]
        while total_bytes > budget:
            row = self._db.execute(
                "SELECT id,size_bytes FROM runs ORDER BY started_at ASC LIMIT 1"
            ).fetchone()
            if not row:
                break
            self._db.execute("DELETE FROM runs WHERE id=?", (row[0],))
            self._db.execute(
                "DELETE FROM graphs WHERE revision NOT IN "
                "(SELECT DISTINCT graph_revision FROM runs)"
            )
            total_bytes = self._db.execute(
                "SELECT (SELECT coalesce(sum(size_bytes),0) FROM runs) + "
                "(SELECT coalesce(sum(size_bytes),0) FROM graphs)"
            ).fetchone()[0]

    def _stats_locked(self) -> dict[str, Any]:
        count, data_bytes = self._db.execute(
            "SELECT (SELECT count(*) FROM runs), "
            "(SELECT coalesce(sum(size_bytes),0) FROM runs) + "
            "(SELECT coalesce(sum(size_bytes),0) FROM graphs)"
        ).fetchone()
        database_bytes = self.path.stat().st_size if self.path.exists() else 0
        wal = Path(str(self.path) + "-wal")
        database_bytes += wal.stat().st_size if wal.exists() else 0
        return {
            "runs": count,
            "data_bytes": data_bytes,
            "database_bytes": database_bytes,
            "queue_depth": self._queue.qsize(),
            "queue_capacity": _MAX_QUEUE,
            "dropped": self.dropped,
            "error": self.error,
        }

    def _set_page_limit_locked(self, settings: dict[str, Any] | None = None) -> None:
        if self._available:
            settings = settings or self._settings
            pages = max(32, settings["max_bytes"] // 4096 + 64)
            self._db.execute(f"PRAGMA max_page_count={pages}")
