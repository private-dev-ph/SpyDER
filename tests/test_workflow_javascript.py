import pytest

from spyder_cctv.workflow_code import CodeError, run_code, validate_code

quickjs = pytest.importorskip("quickjs")


DETECTIONS = [
    {"label": "person", "confidence": 0.8, "bbox": [10, 10, 30, 30]},
    {"label": "car", "confidence": 0.4, "bbox": [40, 40, 80, 80]},
]


def test_javascript_filter_uses_detections_and_context():
    source = "output = detections.filter(d => d.confidence >= 0.5 && context.camera_id === 'cam1');"
    assert validate_code(source, "javascript") is None
    assert run_code(source, DETECTIONS, {"camera_id": "cam1"}, "javascript") == [DETECTIONS[0]]


def test_javascript_context_is_read_only():
    with pytest.raises(CodeError):
        run_code(
            "context.camera_id = 'other'; output = detections;",
            DETECTIONS,
            {"camera_id": "cam1"},
            "javascript",
        )


@pytest.mark.parametrize(
    "source",
    [
        "output = detections.filter(d => d.label === 'person';",
        "output = detections.filter(d => d.label === 'person'); " + " " * 8001,
    ],
)
def test_javascript_validation_rejects_invalid_or_oversized_source(source):
    with pytest.raises(ValueError):
        validate_code(source, "javascript")


def test_javascript_validation_cannot_escape_compile_only_wrapper():
    source = "}); throw new Error('source executed during validation'); (function() {"
    with pytest.raises(ValueError, match="invalid JavaScript syntax"):
        validate_code(source, "javascript")


def test_javascript_has_no_host_file_or_network_globals():
    source = (
        "if (typeof process !== 'undefined' || typeof require !== 'undefined' "
        "|| typeof fetch !== 'undefined' || typeof XMLHttpRequest !== 'undefined' "
        "|| typeof Deno !== 'undefined' || typeof Bun !== 'undefined') "
        "throw new Error('host global exposed'); "
        "output = detections;"
    )
    assert run_code(source, DETECTIONS, {}, "javascript") == DETECTIONS


def test_javascript_infinite_loop_hits_engine_time_limit():
    with pytest.raises(CodeError, match="100 ms"):
        run_code("while (true) {}", DETECTIONS, {}, "javascript")


def test_javascript_allocation_hits_engine_memory_limit():
    with pytest.raises(CodeError, match="8 MiB"):
        run_code(
            "const values = new Array(10000000).fill('x'); output = detections;",
            DETECTIONS,
            {},
            "javascript",
        )


def test_javascript_output_uses_python_detection_schema():
    with pytest.raises(CodeError, match="known detection fields"):
        run_code(
            "output = [{label: 'person', bbox: [0, 0, 1, 1], secret: 1}];",
            DETECTIONS,
            {},
            "javascript",
        )


def test_javascript_output_schema_ignores_inherited_prototype_fields():
    source = (
        "const candidate = Object.create({label: 'person', bbox: [0, 0, 1, 1]}); "
        "output = [candidate];"
    )
    with pytest.raises(CodeError, match="known detection fields"):
        run_code(source, DETECTIONS, {}, "javascript")


@pytest.mark.parametrize(
    "source",
    ["output = null;", "output = [null];", "output = [{label: 'person', bbox: [0, 0, NaN, 1]}];"],
)
def test_javascript_invalid_json_output_shapes_rejected(source):
    with pytest.raises(CodeError):
        run_code(source, DETECTIONS, {}, "javascript")
