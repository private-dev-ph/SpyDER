import gzip
import json
from pathlib import Path

import pytest

from spyder_cctv.recording_overlays import (
    CHUNK_SECONDS,
    MAX_BOXES,
    MAX_CHUNK_INDEX,
    MAX_DECODED_CHUNK_BYTES,
    MAX_RECORDS,
    OverlayWriter,
    read_chunk,
    remove_sidecars,
    sidecar_paths,
    used_sidecar_bytes,
)

MEDIA_ID = "0123456789abcdef0123456789abcdef"


def box(x=0.1, *, label="person"):
    return {"bbox": [x, 0.2, 0.3, 0.4], "camera_id": "front", "kind": "person", "label": label}


def test_long_timestamps_rotate_and_carry_state(tmp_path):
    writer = OverlayWriter(tmp_path, MEDIA_ID, 1920, 1080, 30.0)
    stamp = 24 * 60 * 60 + 2.5
    writer.append(stamp, [box()])
    writer.close()

    chunk_index = int(stamp // CHUNK_SECONDS)
    chunk = read_chunk(tmp_path, MEDIA_ID, chunk_index)
    assert chunk is not None
    assert chunk["samples"][-1] == {"time": stamp, "boxes": [box()]}
    assert chunk["samples"][0] == {"time": chunk_index * CHUNK_SECONDS, "boxes": []}
    carry_writer = OverlayWriter(tmp_path, "abcdef0123456789abcdef0123456789", 1920, 1080, 30.0)
    carry_writer.append(1, [box()])
    carry_writer.append(CHUNK_SECONDS + 1, [box()])
    carry_writer.close()
    carry_chunk = read_chunk(tmp_path, "abcdef0123456789abcdef0123456789", 1)
    assert carry_chunk["samples"][-1]["boxes"] == [box()]
    assert carry_chunk["samples"][0]["time"] == CHUNK_SECONDS
    assert len(sidecar_paths(tmp_path, MEDIA_ID)) <= MAX_CHUNK_INDEX + 1


def test_labels_are_bounded_to_96_characters(tmp_path):
    writer = OverlayWriter(tmp_path, MEDIA_ID, 640, 480, 25.0)
    writer.append(0, [box(label="x" * 110)])
    writer.close()
    sample = read_chunk(tmp_path, MEDIA_ID, 0)["samples"][-1]
    assert len(sample["boxes"][0]["label"]) == 96


def test_unchanged_boxes_deduplicate_and_same_timestamp_updates_replace(tmp_path):
    writer = OverlayWriter(tmp_path, MEDIA_ID, 640, 480, 25.0)
    writer.append(1, [box()])
    writer.append(2, [box()])
    writer.append(2, [box(0.4)])
    writer.close()
    samples = read_chunk(tmp_path, MEDIA_ID, 0)["samples"]
    assert samples == [
        {"time": 0.0, "boxes": []},
        {"time": 1.0, "boxes": [box()]},
        {"time": 2.0, "boxes": [box(0.4)]},
    ]


def test_empty_sample_clears_and_next_chunk_starts_with_carry_state(tmp_path):
    writer = OverlayWriter(tmp_path, MEDIA_ID, 640, 480, 25.0)
    writer.append(1, [box()])
    writer.append(4, [])
    writer.append(CHUNK_SECONDS + 1, [box()])
    writer.close()
    assert read_chunk(tmp_path, MEDIA_ID, 0)["samples"][-1]["boxes"] == []
    assert read_chunk(tmp_path, MEDIA_ID, 1)["samples"][0]["boxes"] == []


def test_record_and_box_limits_fail_closed(tmp_path):
    writer = OverlayWriter(tmp_path, MEDIA_ID, 640, 480, 60.0)
    for sample in range(MAX_RECORDS + 20):
        writer.append(sample / 60, [box(x=(sample % 10) / 20)])
    writer.close()
    chunk = read_chunk(tmp_path, MEDIA_ID, 0)
    assert chunk["truncated"] is True
    assert chunk["samples"][-1]["boxes"] == []
    assert len(chunk["samples"]) <= MAX_RECORDS

    other_id = "fedcba9876543210fedcba9876543210"
    writer = OverlayWriter(tmp_path, other_id, 640, 480, 30.0)
    writer.append(0, [box()] * (MAX_BOXES + 1))
    writer.close()
    chunk = read_chunk(tmp_path, other_id, 0)
    assert chunk["truncated"] is True
    assert chunk["samples"][-1]["boxes"] == []


def test_invalid_ids_and_indices_do_not_access_paths(tmp_path):
    with pytest.raises(ValueError):
        read_chunk(tmp_path, "../../escape", 0)
    with pytest.raises(ValueError):
        read_chunk(tmp_path, MEDIA_ID, MAX_CHUNK_INDEX + 1)
    with pytest.raises(ValueError):
        sidecar_paths(tmp_path, "..")
    with pytest.raises(ValueError):
        remove_sidecars(tmp_path, "../target")


def test_corrupt_and_gzip_bomb_chunks_fail_safely(tmp_path):
    path = tmp_path / f"{MEDIA_ID}.overlays-000000.json.gz"
    path.write_bytes(b"not gzip")
    with pytest.raises(ValueError):
        read_chunk(tmp_path, MEDIA_ID, 0)

    payload = json.dumps({
        "version": 1, "chunk_seconds": 30, "index": 0, "width": 1, "height": 1,
        "fps": 1.0, "samples": [{"time": 0.0, "boxes": []}], "truncated": False,
    }).encode() + b" " * (MAX_DECODED_CHUNK_BYTES + 1)
    with gzip.open(path, "wb") as stream:
        stream.write(payload)
    with pytest.raises(ValueError):
        read_chunk(tmp_path, MEDIA_ID, 0)


def test_failed_atomic_replace_preserves_previous_chunk(tmp_path, monkeypatch):
    import spyder_cctv.recording_overlays as overlays

    writer = OverlayWriter(tmp_path, MEDIA_ID, 320, 240, 15.0)
    writer.append(0, [box()])
    writer.checkpoint()
    destination = tmp_path / f"{MEDIA_ID}.overlays-000000.json.gz"
    previous = destination.read_bytes()

    writer.append(1, [box(0.4)])
    monkeypatch.setattr(overlays.os, "replace", lambda *_args: (_ for _ in ()).throw(OSError("replace failed")))
    with pytest.raises(OSError):
        writer.checkpoint()
    assert destination.read_bytes() == previous
    assert not any(path.name.endswith(".tmp") for path in tmp_path.iterdir())


def test_writer_checkpoints_atomically_and_byte_accounting_includes_temporary(tmp_path):
    writer = OverlayWriter(tmp_path, MEDIA_ID, 320, 240, 15.0)
    writer.append(0, [box()])
    writer.checkpoint()
    chunk_path = tmp_path / f"{MEDIA_ID}.overlays-000000.json.gz"
    assert chunk_path.exists()
    assert used_sidecar_bytes(tmp_path) == chunk_path.stat().st_size
    temp_path = tmp_path / f".{chunk_path.name}.test.tmp"
    temp_path.write_bytes(b"pending")
    assert used_sidecar_bytes(tmp_path) == chunk_path.stat().st_size + len(b"pending")
    writer.close()
    assert read_chunk(tmp_path, MEDIA_ID, 0) is not None
    remove_sidecars(tmp_path, MEDIA_ID)
    assert sidecar_paths(tmp_path, MEDIA_ID) == []
    assert temp_path.exists() is False

