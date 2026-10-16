import pytest

from spyder_cctv.cv.contracts import Detection, VisionConfig


def test_detection_identity_and_cosine_are_optional_and_serializable():
    result = Detection("face", (0, 0, 1, 1), identity="Ada", similarity=0.82).to_dict()
    assert result["identity"] == "Ada"
    assert result["similarity"] == 0.82
    assert Detection("face", (0, 0, 1, 1)).identity is None


@pytest.mark.parametrize(
    "kwargs",
    [
        {"identity": ""},
        {"identity": "x" * 129},
        {"similarity": float("nan")},
        {"similarity": 1.01},
        {"similarity": True},
    ],
)
def test_detection_rejects_invalid_recognition_fields(kwargs):
    with pytest.raises(ValueError):
        Detection("face", (0, 0, 1, 1), **kwargs)


def test_recognition_config_requires_insightface_and_local_model_pair():
    with pytest.raises(ValueError):
        VisionConfig(engine="opencv", recognition_model="rec.onnx", identity_gallery="people.json")
    with pytest.raises(ValueError):
        VisionConfig(engine="insightface", model="det.onnx", recognition_model="rec.onnx")
    with pytest.raises(ValueError):
        VisionConfig(
            engine="insightface",
            model="det.onnx",
            recognition_model="https://host/rec.onnx",
            identity_gallery="people.json",
        )
    with pytest.raises(ValueError):
        VisionConfig(
            engine="insightface",
            model="det.onnx",
            recognition_model="rec.onnx",
            identity_gallery="people.json",
            recognition_threshold=float("inf"),
        )


def test_recognition_paths_resolve_with_other_model_path(tmp_path):
    config = VisionConfig(
        engine="insightface",
        model="det.onnx",
        recognition_model="rec.onnx",
        identity_gallery="people.json",
    ).resolve(tmp_path)
    assert config.model == str(tmp_path / "det.onnx")
    assert config.recognition_model == str(tmp_path / "rec.onnx")
    assert config.identity_gallery == str(tmp_path / "people.json")
