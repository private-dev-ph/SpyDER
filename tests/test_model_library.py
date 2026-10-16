import io
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from types import SimpleNamespace

import pytest

from spyder_cctv.model_library import ModelLibrary


def test_registry_persists_descriptor_and_metadata(tmp_path):
    media = tmp_path / "media"
    media.mkdir()
    model = tmp_path / "detector.pt"
    model.write_bytes(b"weights")
    library = ModelLibrary(media)
    descriptor = library.register(str(model), engine="yolo")
    assert descriptor["classes"] == []
    assert descriptor["metadata"]["inspection"] == "unverified"
    assert library.get(descriptor["id"])["path"] == str(model.resolve())
    library.update_metadata(descriptor["id"], classes=["person", "car"], name="Local")
    restored = ModelLibrary(media)
    assert restored.list()[0]["name"] == "Local"
    assert restored.list()[0]["classes"] == ["person", "car"]
    assert json.loads((tmp_path / "models" / "registry.json").read_text())[0]["engine"] == "yolo"


def test_upload_uses_safe_basename_and_failed_upload_cleans_file(tmp_path):
    media = tmp_path / "media"
    media.mkdir()
    library = ModelLibrary(media)
    descriptor = library.upload("../../weights.pt", "yolo", io.BytesIO(b"abc"), 3)
    assert descriptor["path"].startswith(str(tmp_path / "models"))
    assert open(descriptor["path"], "rb").read() == b"abc"
    with pytest.raises(ValueError):
        library.upload("unsafe.onnx", "insightface", io.BytesIO(b"x"), 2)
    assert len(list((tmp_path / "models").glob("*.onnx"))) == 0


def test_uploaded_model_survives_restart_and_source_removal(tmp_path):
    media = tmp_path / "media"
    media.mkdir()
    library = ModelLibrary(media)
    descriptor = library.upload("original.pt", "yolo", io.BytesIO(b"weights"), 7)
    restored_path = descriptor["path"]
    library = None
    restored = ModelLibrary(media)
    assert restored.get(descriptor["id"])["path"] == restored_path
    assert open(restored_path, "rb").read() == b"weights"


def test_remove_deletes_uploaded_weights_but_preserves_registered_source(tmp_path):
    media = tmp_path / "media"
    media.mkdir()
    source = tmp_path / "external.pt"
    source.write_bytes(b"external")
    library = ModelLibrary(media)
    external = library.register(str(source), engine="yolo")
    uploaded = library.upload("upload.pt", "yolo", io.BytesIO(b"owned"), 5)
    assert external["uploaded"] is False
    assert uploaded["uploaded"] is True

    assert library.remove(external["id"]) == {
        "removed": True,
        "id": external["id"],
        "deleted_file": False,
    }
    assert source.read_bytes() == b"external"
    assert library.remove(uploaded["id"]) == {
        "removed": True,
        "id": uploaded["id"],
        "deleted_file": True,
    }
    assert not Path(uploaded["path"]).exists()


def test_remove_restores_registry_and_uploaded_file_when_save_fails(tmp_path, monkeypatch):
    media = tmp_path / "media"
    media.mkdir()
    library = ModelLibrary(media)
    uploaded = library.upload("upload.pt", "yolo", io.BytesIO(b"owned"), 5)
    monkeypatch.setattr(library, "_save", lambda: (_ for _ in ()).throw(OSError("disk full")))

    with pytest.raises(OSError, match="disk full"):
        library.remove(uploaded["id"])
    assert library.get(uploaded["id"])["id"] == uploaded["id"]
    assert Path(uploaded["path"]).read_bytes() == b"owned"


def test_remove_preserves_uploaded_weights_referenced_by_another_registry_row(tmp_path):
    media = tmp_path / "media"
    media.mkdir()
    library = ModelLibrary(media)
    uploaded = library.upload("upload.pt", "yolo", io.BytesIO(b"owned"), 5)
    alias = dict(library._models[uploaded["id"]])
    alias["id"] = "a" * 32
    library._models[alias["id"]] = alias
    library._save()

    outcome = library.remove(uploaded["id"])

    assert outcome["deleted_file"] is False
    assert Path(uploaded["path"]).read_bytes() == b"owned"
    assert library.get(alias["id"])["path"] == uploaded["path"]


def test_remove_reports_failed_uploaded_file_cleanup(tmp_path, monkeypatch):
    media = tmp_path / "media"
    media.mkdir()
    library = ModelLibrary(media)
    uploaded = library.upload("upload.pt", "yolo", io.BytesIO(b"owned"), 5)
    original_unlink = Path.unlink

    def fail_quarantine(path, *args, **kwargs):
        if path.name.startswith(".remove-"):
            raise PermissionError("blocked")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_quarantine)
    outcome = library.remove(uploaded["id"])

    assert outcome["removed"] is True
    assert outcome["deleted_file"] is False
    assert outcome["retained_quarantine"] is True
    assert outcome["cleanup_error"]


def test_instances_reload_reads_and_metadata_changes(tmp_path):
    media = tmp_path / "media"
    media.mkdir()
    first = ModelLibrary(media)
    second = ModelLibrary(media)
    model = tmp_path / "weights.pt"
    model.write_bytes(b"weights")
    descriptor = first.register(str(model), engine="yolo")
    assert second.get(descriptor["id"])["id"] == descriptor["id"]
    first.update_metadata(descriptor["id"], name="Updated")
    assert second.list()[0]["name"] == "Updated"


def test_concurrent_separate_instances_keep_all_registrations(tmp_path):
    media = tmp_path / "media"
    media.mkdir()
    libraries = [ModelLibrary(media), ModelLibrary(media)]
    models = []
    for index in range(12):
        path = tmp_path / f"separate-{index}.pt"
        path.write_bytes(b"weights")
        models.append(path)
    barrier = Barrier(2)

    def register(index):
        barrier.wait()
        return libraries[index % 2].register(str(models[index]), engine="yolo")

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(register, range(2)))
    # Repeat concurrent writers after both instances have cached the same stamp.
    barrier = Barrier(2)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(register, range(2, 4)))
    assert len(libraries[0].list()) == 4
    assert len(libraries[1].list()) == 4


def test_registry_lock_timeout_is_clear_and_does_not_write(tmp_path, monkeypatch):
    import spyder_cctv.model_library as model_library

    media = tmp_path / "media"
    media.mkdir()
    first = ModelLibrary(media)
    second = ModelLibrary(media)
    model = tmp_path / "weights.pt"
    model.write_bytes(b"weights")
    monkeypatch.setattr(model_library, "LOCK_TIMEOUT_SECONDS", 0.05)
    with first._registry_lock():
        with pytest.raises(TimeoutError, match="Timed out waiting"):
            second.register(str(model), engine="yolo")
    assert first.list() == []


def test_separate_processes_preserve_concurrent_uploads(tmp_path):
    import spyder_cctv

    library = ModelLibrary(tmp_path / "media")
    assert library.list() == []
    script = """
import io, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from spyder_cctv.model_library import ModelLibrary
library = ModelLibrary(Path(sys.argv[2]) / 'media')
print('ready', flush=True)
sys.stdin.readline()
for index in range(4):
    library.upload('weights.pt', 'yolo', io.BytesIO(b'weights'), 7)
"""
    source = str(Path(spyder_cctv.__file__).parent.parent)
    processes = [
        subprocess.Popen(
            [sys.executable, "-c", script, source, str(tmp_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for _ in range(2)
    ]
    try:
        for process in processes:
            assert process.stdout.readline().strip() == "ready"
        for process in processes:
            process.stdin.write("go\n")
            process.stdin.flush()
        for process in processes:
            _, errors = process.communicate(timeout=15)
            assert process.returncode == 0, errors
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)
    assert len(library.list()) == 8
    assert all(Path(row["path"]).read_bytes() == b"weights" for row in library.list())


def test_distinct_data_roots_have_distinct_registries(tmp_path):
    first_media = tmp_path / "one" / "media"
    second_media = tmp_path / "two" / "media"
    first_media.mkdir(parents=True)
    second_media.mkdir(parents=True)
    model = tmp_path / "weights.pt"
    model.write_bytes(b"weights")
    first = ModelLibrary(first_media)
    first.register(str(model), engine="yolo")
    second = ModelLibrary(second_media)
    assert second.list() == []


@pytest.mark.parametrize("filename,engine", [("x.pt", "insightface"), ("x.onnx", "bad")])
def test_upload_rejects_engine_extension_mismatch(tmp_path, filename, engine):
    media = tmp_path / "media"
    media.mkdir()
    with pytest.raises(ValueError):
        ModelLibrary(media).upload(filename, engine, io.BytesIO(b"x"), 1)


def test_local_registration_rejects_urls_and_missing_paths(tmp_path):
    media = tmp_path / "media"
    media.mkdir()
    library = ModelLibrary(media)
    for path in ("https://example/model.pt", str(tmp_path / "missing.pt")):
        with pytest.raises(ValueError):
            library.register(path, engine="yolo")


def test_metadata_validation_is_transactional_and_descriptors_are_copies(tmp_path):
    media = tmp_path / "media"
    media.mkdir()
    model = tmp_path / "weights.pt"
    model.write_bytes(b"weights")
    library = ModelLibrary(media)
    descriptor = library.register(str(model), engine="yolo")
    returned = library.list()[0]
    returned["settings"]["model"] = "changed"
    with pytest.raises(ValueError):
        library.update_metadata(descriptor["id"], name="Changed", classes=[None])
    saved = library.list()[0]
    assert saved["name"] == "weights"
    assert saved["settings"]["model"] == str(model.resolve())


def test_corrupt_registry_is_preserved_and_reported(tmp_path):
    models = tmp_path / "models"
    models.mkdir()
    registry = models / "registry.json"
    registry.write_text("{broken", encoding="utf-8")
    library = ModelLibrary(tmp_path / "media")
    assert library.list() == []
    assert "preserved" in library.storage_error
    with pytest.raises(RuntimeError, match="preserved"):
        library.register("would-not-be-read.pt", engine="yolo")
    assert registry.read_text(encoding="utf-8") == "{broken"


def test_concurrent_registration_enforces_capacity(tmp_path):
    media = tmp_path / "media"
    media.mkdir()
    library = ModelLibrary(media)
    paths = []
    for index in range(65):
        path = tmp_path / f"{index}.pt"
        path.write_bytes(b"weights")
        paths.append(path)

    def register(path):
        try:
            return library.register(str(path), engine="yolo")
        except ValueError as error:
            return str(error)

    with ThreadPoolExecutor(max_workers=12) as pool:
        outcomes = list(pool.map(register, paths))
    assert len(library.list()) == 64
    assert sum(isinstance(item, str) for item in outcomes) == 1


def test_upload_rejects_engine_before_reading_body(tmp_path):
    media = tmp_path / "media"
    media.mkdir()

    class MustNotRead:
        def read(self, _size):
            raise AssertionError("invalid engine must be rejected before reading bytes")

    with pytest.raises(ValueError, match="Engine"):
        ModelLibrary(media).upload("model.pt", "invalid", MustNotRead(), 256 * 1024 * 1024)


def test_onnx_python_repr_names_are_parsed_without_evaluation(tmp_path, monkeypatch):
    model = tmp_path / "detector.onnx"
    model.write_bytes(b"placeholder")
    props = [SimpleNamespace(key="names", value="{0: 'person', 1: 'vehicle'}")]
    fake_onnx = SimpleNamespace(
        load=lambda _path, load_external_data: SimpleNamespace(metadata_props=props)
    )
    monkeypatch.setitem(sys.modules, "onnx", fake_onnx)
    classes, metadata = ModelLibrary._inspect(model, "yolo")
    assert classes == ["person", "vehicle"]
    assert metadata["inspection"] == "metadata inspected"


def test_face_classifier_classes_metadata_is_extracted_with_its_role(tmp_path, monkeypatch):
    model = tmp_path / "CBE100_Classified.onnx"
    model.write_bytes(b"metadata fixture")
    props = {
        "classes": '["identity-one", "identity-two"]',
        "model_type": "face_classifier",
        "input_size": "[112, 112]",
        "num_classes": "2",
        "unknown_rejection": "none; always selects a trained identity",
        "probability_type": "closed_set_softmax_not_calibrated_confidence",
    }
    monkeypatch.setitem(
        sys.modules,
        "onnx",
        SimpleNamespace(
            load=lambda *_args, **_kwargs: SimpleNamespace(
                metadata_props=[SimpleNamespace(key=k, value=v) for k, v in props.items()]
            )
        ),
    )
    classes, metadata = ModelLibrary._inspect(model, "insightface")
    assert classes == ["identity-one", "identity-two"]
    assert metadata["model_type"] == "face_classifier"
    assert metadata["label_semantics"] == "identity"
    assert metadata["class_source"] == "classes"
    assert "classifier" in metadata["compatibility"]
    assert metadata["unknown_rejection"] == props["unknown_rejection"]


def test_reinspection_repairs_existing_upload_and_preserves_manual_labels(tmp_path, monkeypatch):
    source = tmp_path / "weights.onnx"
    source.write_bytes(b"metadata fixture")
    library = ModelLibrary(tmp_path / "media")
    monkeypatch.setattr(
        ModelLibrary, "_inspect", staticmethod(lambda *_: ([], {"inspection": "unverified"}))
    )
    entry = library.register(str(source), engine="insightface")
    assert entry["classes"] == []
    monkeypatch.setattr(
        ModelLibrary,
        "_inspect",
        staticmethod(
            lambda *_: (
                ["identity-one"],
                {
                    "inspection": "metadata inspected",
                    "model_type": "face_classifier",
                    "class_source": "classes",
                },
            )
        ),
    )
    repaired = library.reinspect(entry["id"])
    assert repaired["classes"] == ["identity-one"]
    assert ModelLibrary(tmp_path / "media").get(entry["id"])["classes"] == ["identity-one"]
    library.update_metadata(entry["id"], classes=["custom-label"])
    assert library.reinspect(entry["id"])["classes"] == ["custom-label"]
    assert library.list()[0]["metadata"]["model_type"] == "face_classifier"


def test_invalid_legacy_labels_do_not_hide_valid_classes_key(tmp_path, monkeypatch):
    model = tmp_path / "weights.onnx"
    model.write_bytes(b"fixture")
    props = {"names": "not a label list", "classes": '["one", "two"]'}
    monkeypatch.setitem(
        sys.modules,
        "onnx",
        SimpleNamespace(
            load=lambda *_args, **_kwargs: SimpleNamespace(
                metadata_props=[SimpleNamespace(key=k, value=v) for k, v in props.items()]
            )
        ),
    )
    labels, metadata = ModelLibrary._inspect(model, "insightface")
    assert labels == ["one", "two"]
    assert metadata["class_source"] == "classes"


def test_chosen_metadata_source_persists_and_manual_labels_stay_protected(tmp_path, monkeypatch):
    source = tmp_path / "ambiguous.onnx"
    source.write_bytes(b"fixture")
    props = {"names": '["First"]', "classes": '["Second"]'}
    monkeypatch.setitem(
        sys.modules,
        "onnx",
        SimpleNamespace(
            load=lambda *_args, **_kwargs: SimpleNamespace(
                metadata_props=[SimpleNamespace(key=k, value=v) for k, v in props.items()]
            )
        ),
    )
    library = ModelLibrary(tmp_path / "media")
    model = library.register(str(source), engine="insightface")
    assert model["classes"] == []
    assert model["metadata"]["resolution"] == "ambiguous"
    model = library.reinspect(model["id"], label_source="/classes")
    assert model["classes"] == ["Second"]
    assert model["metadata"]["resolution"] == "selected"
    assert (
        ModelLibrary(tmp_path / "media").get(model["id"])["metadata"]["label_source"] == "/classes"
    )
    props["classes"] = '["Updated"]'
    assert library.reinspect(model["id"])["classes"] == ["Updated"]
    library.update_metadata(model["id"], classes=["Manual"])
    assert library.reinspect(model["id"])["classes"] == ["Manual"]
    with pytest.raises(ValueError):
        library.reinspect(model["id"], label_source="/missing")
    assert library.get(model["id"])["classes"] == ["Manual"]
    automatic = library.reinspect(model["id"], reset_source=True)
    assert automatic["metadata"]["resolution"] == "ambiguous"
    assert automatic["classes"] == []
