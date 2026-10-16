import pytest

import spyder_cctv.workflow_code as workflow_code
from spyder_cctv.workflow_code import run_code, validate_code

DETECTIONS = [
    {"label": "person", "confidence": 0.8, "bbox": [10, 10, 30, 30]},
    {"label": "car", "confidence": 0.4, "bbox": [40, 40, 80, 80]},
]


def test_validate_and_filter_transform_with_context_and_comprehension():
    source = "output = [d for d in detections if d.get('confidence', 0) >= 0.5 and d.get('label')]"
    assert validate_code(source) is None
    assert run_code(source, DETECTIONS, {"camera_id": "cam1", "sequence": 3}) == [DETECTIONS[0]]


def test_mutation_and_bounded_for_loop():
    source = (
        "output = []\nfor d in detections:\n"
        "    if d['label'] == 'person':\n        output.append(d)"
    )
    assert run_code(source, DETECTIONS, {}) == [DETECTIONS[0]]


@pytest.mark.parametrize(
    "source",
    [
        "import os",
        "output = __import__('os').system('whoami')",
        "output = open('/etc/passwd').read()",
        "while True:\n    pass",
        "def f(): pass",
        "output = detections[0].__class__",
        "output = [x ** 2 for x in [1]]",
        "output = [x for x in detections if (lambda: 1)()]",
    ],
)
def test_rejects_unsafe_or_unsupported_syntax(source):
    with pytest.raises(ValueError):
        validate_code(source)


def test_context_is_not_mutable():
    with pytest.raises(ValueError, match="read-only"):
        validate_code("context['camera_id'] = 'other'")
    with pytest.raises(ValueError, match="read-only"):
        validate_code("context['frame_size'].append(1)")


def test_rejects_source_and_ast_limits():
    with pytest.raises(ValueError, match="8000 bytes"):
        validate_code(" " * 8001)
    with pytest.raises(ValueError, match="syntax nodes"):
        validate_code("output = [" + ",".join("1" for _ in range(1000)) + "]")


def test_bounds_runtime_steps_and_loop_input(monkeypatch):
    monkeypatch.setattr(workflow_code.time, "monotonic", lambda: 0)
    with pytest.raises(RuntimeError, match="execution steps"):
        run_code(
            "x = 0\nfor d in detections:\n"
            "    for e in detections:\n        x = x + 1\noutput = detections",
            DETECTIONS * 100,
            {},
        )
    with pytest.raises(ValueError, match="at most 500"):
        run_code("output = detections", DETECTIONS * 251, {})


def test_validates_output_schema_and_context():
    with pytest.raises(RuntimeError, match="known detection fields"):
        run_code("output = [{'label': 'person', 'secret': 1}]", DETECTIONS, {})
    with pytest.raises(ValueError, match="Context may contain only"):
        run_code("output = detections", DETECTIONS, {"path": "/tmp/a"})
    with pytest.raises(RuntimeError, match="bbox"):
        run_code("output = [{'label': 'person', 'bbox': [1, 2]}]", DETECTIONS, {})


def test_rejects_unbounded_values_and_string_formatting():
    with pytest.raises(ValueError, match="Numeric constants"):
        validate_code("output = 1000000000001")
    with pytest.raises(ValueError, match="String formatting"):
        run_code("output = detections\nx = '%100000000s' % 'x'", DETECTIONS, {})
    with pytest.raises(ValueError, match="Cyclic values"):
        run_code("a = []\na.append(a)\noutput = detections", DETECTIONS, {})
    with pytest.raises(ValueError, match="16 levels"):
        run_code(
            "a = []\nfor d in detections:\n    a = [a, a]\noutput = detections",
            DETECTIONS[:1] * 32,
            {},
        )


def test_code_mutation_does_not_change_input_detections():
    original = [dict(DETECTIONS[0], bbox=list(DETECTIONS[0]["bbox"]))]
    run_code(
        "output = []\nfor d in detections:\n    d['label'] = 'changed'\n    output.append(d)",
        original,
        {"camera_id": "cam1"},
    )
    assert original[0]["label"] == "person"


def test_for_else_runs_after_bounded_iteration():
    source = (
        "output = []\nfor detection in []:\n"
        "    output.append(detection)\nelse:\n    output = detections"
    )
    assert run_code(source, DETECTIONS, {}) == DETECTIONS


def test_code_round_trip_preserves_classifier_probability():
    detections = [
        {
            "label": "face",
            "bbox": [1, 1, 10, 10],
            "confidence": 0.8,
            "identity": "Alice",
            "identity_confidence": 0.9,
            "similarity": None,
        }
    ]
    assert run_code("output = detections", detections, {}) == detections
    detections[0]["identity_confidence"] = 1.1
    with pytest.raises(ValueError, match="identity_confidence"):
        run_code("output = detections", detections, {})
