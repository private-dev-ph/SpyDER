import json
from types import SimpleNamespace

import pytest

from spyder_cctv.model_metadata import inspect_metadata


def model(props, outputs=()):
    return SimpleNamespace(
        metadata_props=[SimpleNamespace(key=key, value=value) for key, value in props.items()],
        graph=SimpleNamespace(output=list(outputs)),
    )


def output(last_dim):
    dims = [SimpleNamespace(dim_value=1), SimpleNamespace(dim_value=last_dim)]
    return SimpleNamespace(
        name="logits",
        type=SimpleNamespace(tensor_type=SimpleNamespace(shape=SimpleNamespace(dim=dims))),
    )


@pytest.mark.parametrize("key", ["ClassNames", "class_names", "CLASS-NAMES", "labelNames"])
def test_known_aliases_ignore_case_and_punctuation(key):
    labels, metadata = inspect_metadata(model({key: '["person", "vehicle"]'}))
    assert labels == ["person", "vehicle"]
    assert metadata["resolution"] == "automatic"
    assert metadata["class_source"] == key


def test_nested_json_alias_and_numeric_mapping():
    labels, metadata = inspect_metadata(
        model({"bundle": json.dumps({"labels": {"0": "cat", "1": "dog"}})})
    )
    assert labels == ["cat", "dog"]
    assert metadata["label_source"] == "/bundle/labels"


def test_record_arrays_and_name_to_id_mapping():
    records = '[{"class_id": 1, "class_name": "dog"}, {"class_id": 0, "class_name": "cat"}]'
    labels, _ = inspect_metadata(model({"classes": records}))
    assert labels == ["cat", "dog"]
    labels, _ = inspect_metadata(model({"label2id": '{"cat": 0, "dog": 1}'}))
    assert labels == ["cat", "dog"]


@pytest.mark.parametrize(
    "records",
    [
        '[{"id": 0, "name": "cat"}, {"id": 2, "name": "dog"}]',
        '[{"id": 0, "name": "cat"}, {"id": 0, "name": "dog"}]',
    ],
)
def test_sparse_or_repeated_record_ids_are_rejected(records):
    labels, _ = inspect_metadata(model({"classes": records}))
    assert labels == []


def test_unknown_candidate_requires_count_and_output_dimension():
    source = model({"vendor_blob": '{"taxonomy": ["cat", "dog"]}', "class_count": "2"}, [output(2)])
    labels, metadata = inspect_metadata(source)
    assert labels == ["cat", "dog"]
    assert metadata["resolution"] == "automatic"
    assert metadata["label_candidates"][0]["confidence"] == "review"


def test_known_candidate_count_mismatch_requires_review():
    labels, metadata = inspect_metadata(model({"classes": '["cat", "dog"]', "num_classes": "3"}))
    assert labels == []
    assert metadata["resolution"] == "ambiguous"
    assert metadata["label_candidates"][0]["confidence"] == "review"


@pytest.mark.parametrize("key", ["authors", "providers", "output_names", "input_size"])
def test_non_label_arrays_never_auto_select(key):
    labels, metadata = inspect_metadata(
        model({key: '["cat", "dog"]', "class_count": "2"}, [output(2)])
    )
    assert labels == []
    assert metadata["resolution"] == "unrecognized"


def test_rank_three_output_does_not_corroborate_classifier():
    rank_three = SimpleNamespace(
        name="scores",
        type=SimpleNamespace(
            tensor_type=SimpleNamespace(
                shape=SimpleNamespace(
                    dim=[
                        SimpleNamespace(dim_value=1),
                        SimpleNamespace(dim_value=4),
                        SimpleNamespace(dim_value=2),
                    ]
                )
            )
        ),
    )
    labels, _ = inspect_metadata(
        model({"taxonomy": '["cat", "dog"]', "class_count": "2"}, [rank_three])
    )
    assert labels == []


def test_known_labels_accept_single_row_csv_and_newlines():
    labels, _ = inspect_metadata(model({"class-names": "cat, dog, bird"}))
    assert labels == ["cat", "dog", "bird"]
    labels, _ = inspect_metadata(model({"class-names": "cat\ndog\nbird"}))
    assert labels == ["cat", "dog", "bird"]


def test_nested_normalized_fields_and_role_apply_without_labels():
    payload = json.dumps({"descriptor": {"Model-Type": "FaceClassifier", "Num-Classes": 4}})
    labels, metadata = inspect_metadata(model({"bundle": payload}))
    assert labels == []
    assert metadata["model_type"] == "face_classifier"
    assert metadata["num_classes"] == "4"
    assert metadata["label_semantics"] == "identity"
    assert "classifier adapter" in metadata["compatibility"]


def test_nested_field_conflict_is_reported_and_blocks_automatic_choice():
    payload = json.dumps({"model_type": "detector", "classes": ["a", "b"]})
    labels, metadata = inspect_metadata(model({"model_type": "classifier", "bundle": payload}))
    assert labels == []
    assert "model_type" in metadata["metadata_conflicts"]
    assert metadata["resolution"] == "ambiguous"


def test_double_encoded_json_and_pointer_escaping():
    nested = json.dumps(json.dumps({"mystery/key~": ["one", "two"]}))
    labels, metadata = inspect_metadata(model({"vendor/key~": nested}))
    assert labels == []
    assert metadata["label_candidates"][0]["path"] == "/vendor~1key~0/mystery~1key~0"


def test_unknown_candidate_without_corroboration_requires_review():
    labels, metadata = inspect_metadata(model({"vendor_blob": '{"taxonomy": ["cat", "dog"]}'}))
    assert labels == []
    assert metadata["inspection"] == "review required"
    assert metadata["resolution"] == "unrecognized"


def test_conflicting_known_lists_stay_ambiguous():
    labels, metadata = inspect_metadata(
        model({"classes": '["cat", "dog"]', "labels": '["dog", "cat"]'})
    )
    assert labels == []
    assert metadata["resolution"] == "ambiguous"


def test_explicit_source_resolves_conflict_and_unknown_path_fails():
    source = model({"classes": '["cat", "dog"]', "labels": '["dog", "cat"]'})
    labels, metadata = inspect_metadata(source, label_source="/labels")
    assert labels == ["dog", "cat"]
    assert metadata["resolution"] == "selected"
    with pytest.raises(ValueError, match="Unknown label source"):
        inspect_metadata(source, label_source="/missing")


def test_safe_literal_and_malicious_literal_never_execute(tmp_path):
    marker = tmp_path / "executed"
    payload = "__import__('pathlib').Path(" + repr(str(marker)) + ").touch()"
    labels, metadata = inspect_metadata(model({"classes": payload}))
    assert labels == []
    assert metadata["resolution"] == "none"
    assert not marker.exists()
    labels, _ = inspect_metadata(model({"names": "{0: 'person', 1: 'vehicle'}"}))
    assert labels == ["person", "vehicle"]


def test_parser_rejects_oversized_property():
    labels, metadata = inspect_metadata(model({"labels": '["ok"]', "unused": "x" * 140000}))
    assert labels == ["ok"]
    assert metadata["classes"] == "available"


def test_graph_shape_never_invents_labels():
    labels, metadata = inspect_metadata(model({}, [output(5)]))
    assert labels == []
    assert metadata["resolution"] == "none"


def test_deep_json_fails_closed():
    raw = "[" * 5000 + "0" + "]" * 5000
    labels, _ = inspect_metadata(model({"labels": raw}))
    assert labels == []


def test_face_classifier_and_identity_semantics():
    labels, metadata = inspect_metadata(
        model({"model_type": "face_classifier", "classes": '["person_a", "person_b"]'})
    )
    assert labels == ["person_a", "person_b"]
    assert metadata["label_semantics"] == "identity"
    assert "classifier adapter" in metadata["compatibility"]


def test_legacy_cbe_class_metadata():
    labels, metadata = inspect_metadata(model({"names": "{0: 'person', 1: 'vehicle'}"}))
    assert labels == ["person", "vehicle"]
    assert metadata["class_source"] == "names"
    assert metadata["inspection"] == "metadata inspected"
