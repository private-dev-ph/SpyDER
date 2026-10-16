from spyder_cctv.cv.contracts import Detection
from spyder_cctv.cv.identity_stability import IdentityStabilizer


def face(x, identity, confidence=0.9, identity_confidence=0.91):
    return Detection(
        "face",
        (x, 0, x + 10, 10),
        confidence=0.8,
        identity=identity,
        identity_confidence=identity_confidence,
    )


def ids(stabilizer, detections, now):
    return [item.identity for item in stabilizer.update(detections, now)]


def test_alternating_predictions_never_confirm():
    stabilizer = IdentityStabilizer()
    assert [
        ids(stabilizer, [face(0, label)], t)[0]
        for t, label in enumerate(["a", "b", "a", "b", "a", "b"])
    ] == [None] * 6


def test_first_identity_requires_three_consecutive_predictions():
    stabilizer = IdentityStabilizer()
    assert ids(stabilizer, [face(0, "a")], 0) == [None]
    assert ids(stabilizer, [face(0, "a")], 1) == [None]
    result = stabilizer.update([face(0, "a")], 2)[0]
    assert result.identity == "a"
    assert result.identity_confidence == 0.91


def test_rejection_and_label_mismatch_suppress_confirmed_identity_immediately():
    stabilizer = IdentityStabilizer()
    for t in range(3):
        result = stabilizer.update([face(0, "a")], t)[0]
    assert result.identity == "a"
    assert ids(stabilizer, [face(0, None)], 3) == [None]
    assert ids(stabilizer, [face(0, "b")], 4) == [None]


def test_switch_requires_five_consistent_frames_and_old_identity_returns_immediately():
    stabilizer = IdentityStabilizer()
    for t in range(3):
        result = stabilizer.update([face(0, "a")], t)[0]
    assert result.identity == "a"
    assert ids(stabilizer, [face(0, "b")], 3) == [None]
    assert ids(stabilizer, [face(0, "b")], 4) == [None]
    assert ids(stabilizer, [face(0, "b")], 5) == [None]
    assert ids(stabilizer, [face(0, "b")], 6) == [None]
    assert ids(stabilizer, [face(0, "b")], 7) == ["b"]
    assert ids(stabilizer, [face(0, "a")], 8) == [None]


def test_face_tracks_remain_independent_when_detection_order_changes():
    stabilizer = IdentityStabilizer()
    assert ids(stabilizer, [face(0, "a"), face(30, "b")], 0) == [None, None]
    assert ids(stabilizer, [face(0, "a"), face(30, "b")], 1) == [None, None]
    assert ids(stabilizer, [face(30, "b"), face(0, "a")], 2) == ["b", "a"]


def test_missing_frame_resets_confirmation_and_reappearance_reconfirms():
    stabilizer = IdentityStabilizer()
    for t in range(3):
        result = stabilizer.update([face(0, "a")], t)[0]
    assert result.identity == "a"
    assert stabilizer.update([], 3) == []
    assert ids(stabilizer, [face(0, "a")], 4) == [None]
    assert ids(stabilizer, [face(0, "a")], 5) == [None]
    assert ids(stabilizer, [face(0, "a")], 6) == ["a"]


def test_expired_track_does_not_keep_identity_or_confirmation():
    stabilizer = IdentityStabilizer(ttl=2.5)
    for t in range(3):
        result = stabilizer.update([face(0, "a")], t)[0]
    assert result.identity == "a"
    assert ids(stabilizer, [face(0, "b")], 10) == [None]
    assert ids(stabilizer, [face(0, "b")], 11) == [None]
    assert ids(stabilizer, [face(0, "b")], 12) == ["b"]


def test_tracks_are_bounded_and_do_not_match_boxes_below_iou_threshold():
    stabilizer = IdentityStabilizer(max_tracks=2)
    stabilizer.update([face(0, "a")], 0)
    stabilizer.update([face(0, "a")], 1)
    # A shift of five pixels gives IoU 1/3 and continues the same track.
    assert ids(stabilizer, [face(5, "a")], 2) == ["a"]
    # Two separate far boxes force capacity eviction of the previous track.
    assert ids(stabilizer, [face(40, "b"), face(80, "c")], 3) == [None, None]
    assert len(stabilizer._tracks) <= 2


def test_iou_below_point_three_starts_fresh_confirmation_run():
    stabilizer = IdentityStabilizer()
    for t in range(3):
        result = stabilizer.update([face(0, "a")], t)[0]
    assert result.identity == "a"
    # Six-pixel shift leaves IoU 0.25, so this box cannot inherit track identity.
    assert ids(stabilizer, [face(6, "a")], 3) == [None]


def test_box_shape_is_not_smoothed_and_raw_identity_score_is_preserved():
    stabilizer = IdentityStabilizer(confirmations=1)
    detection = Detection(
        "face", (1, 2, 11, 12), confidence=0.7, identity="a", identity_confidence=0.88
    )
    output = stabilizer.update([detection], 0)[0]
    assert output.bbox == detection.bbox
    assert output.identity_confidence == detection.identity_confidence


def test_new_face_does_not_evict_a_matched_face_before_it_is_processed():
    stabilizer = IdentityStabilizer(max_tracks=2)
    for t in range(3):
        stabilizer.update([face(40, "b"), face(0, "a")], t)
    assert ids(stabilizer, [face(80, "c"), face(40, "b")], 3) == [None, "b"]


def test_excess_current_faces_are_unconfirmed_without_evicting_matched_faces():
    stabilizer = IdentityStabilizer(max_tracks=1)
    for t in range(3):
        stabilizer.update([face(0, "a")], t)
    assert ids(stabilizer, [face(40, "b"), face(0, "a")], 3) == [None, "a"]
    assert len(stabilizer._tracks) == 1
