import json
import uuid

import pytest

from spyder_cctv.events import EventService


class Recorder:
    def __init__(self, root):
        self.output_dir = root
        self.items = {}

    def media_path(self, media_id):
        if media_id not in self.items:
            raise KeyError(media_id)
        return self.output_dir / self.items[media_id]["filename"]

    def status(self):
        return {"items": list(self.items.values())}


def test_event_store_persists_renames_bounds_history_and_deletes(tmp_path):
    recorder = Recorder(tmp_path / "media")
    store = EventService(tmp_path, recorder)
    event = store.create(
        name="Door · Front · 2026-10-16 09:30:00",
        kind="workflow",
        camera_id="front",
        camera_name="Front",
        workflow_id="wf",
        node_id="event",
        message="Person seen",
    )
    reloaded = EventService(tmp_path, recorder)
    assert reloaded.list()["events"] == [event]
    renamed = reloaded.rename(event["id"], "Delivery arrival")
    assert renamed["name"] == "Delivery arrival"
    assert reloaded.delete([event["id"]]) == [event["id"]]
    assert reloaded.list()["events"] == []


def test_media_association_uses_only_recorder_manifest_and_safe_ids(tmp_path):
    media_dir = tmp_path / "media"
    media_dir.mkdir()
    recorder = Recorder(media_dir)
    media_id = uuid.uuid4().hex
    filename = f"{media_id}.jpg"
    (media_dir / filename).write_bytes(b"image")
    recorder.items[media_id] = {
        "id": media_id,
        "kind": "capture",
        "filename": filename,
        "created_at": "2026-10-16T00:00:00+00:00",
        "size_bytes": 5,
        "url": f"/api/media/{media_id}",
    }
    store = EventService(tmp_path, recorder)
    event = store.create(
        name="Front",
        kind="motion",
        camera_id="front",
        camera_name="Front",
        media=[recorder.items[media_id]],
    )
    assert event["media"][0]["id"] == media_id
    assert store.media_path(media_id).read_bytes() == b"image"
    with pytest.raises(ValueError):
        store.media_path("../events.json")
    persisted = json.loads((tmp_path / "events" / "events.json").read_text())
    assert persisted["events"][0]["media"][0]["filename"] == filename


def test_corrupt_store_fails_closed_without_overwriting_source(tmp_path):
    events_dir = tmp_path / "events"
    events_dir.mkdir()
    source = events_dir / "events.json"
    source.write_text("not valid JSON", encoding="utf-8")
    store = EventService(tmp_path, Recorder(tmp_path / "media"))
    with pytest.raises(RuntimeError, match="unreadable"):
        store.create(
            name="Must not overwrite",
            kind="motion",
            camera_id="front",
            camera_name="Front",
        )
    assert source.read_text(encoding="utf-8") == "not valid JSON"


def test_pending_clip_recovers_as_interrupted_after_restart(tmp_path):
    recorder = Recorder(tmp_path / "media")
    store = EventService(tmp_path, recorder)
    event = store.create(name="Front", kind="workflow", camera_id="front", camera_name="Front")
    store.set_attachment_status(event["id"], "pending")
    restored = EventService(tmp_path, recorder).list()["events"][0]
    assert restored["attachment_status"] == "error"
    assert restored["attachment_error"] == "Recording interrupted by app restart"
