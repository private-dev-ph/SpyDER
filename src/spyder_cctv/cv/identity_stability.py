"""Temporal identity confirmation for per-frame face detections."""

from __future__ import annotations

import time
from dataclasses import dataclass, replace

from spyder_cctv.cv.contracts import Detection


@dataclass
class _Track:
    bbox: tuple[float, float, float, float]
    last_seen: float
    present: bool
    stable_identity: str | None = None
    candidate_identity: str | None = None
    candidate_count: int = 0


class IdentityStabilizer:
    """Confirm identities across consecutive frames for the same face track."""

    def __init__(
        self,
        confirmations: int = 3,
        switch_confirmations: int = 5,
        ttl: float = 2.5,
        max_tracks: int = 500,
    ) -> None:
        if type(confirmations) is not int or confirmations < 1:
            raise ValueError("confirmations must be a positive integer")
        if type(switch_confirmations) is not int or switch_confirmations < 1:
            raise ValueError("switch_confirmations must be a positive integer")
        if ttl <= 0:
            raise ValueError("ttl must be positive")
        if type(max_tracks) is not int or max_tracks < 1:
            raise ValueError("max_tracks must be a positive integer")
        self.confirmations = confirmations
        self.switch_confirmations = switch_confirmations
        self.ttl = float(ttl)
        self.max_tracks = max_tracks
        self._tracks: dict[int, _Track] = {}
        self._next_id = 0

    def update(self, detections: list[Detection], now: float | None = None) -> list[Detection]:
        """Return current detections with only temporally confirmed identities."""
        timestamp = time.monotonic() if now is None else float(now)
        expired = [
            key for key, track in self._tracks.items() if timestamp - track.last_seen > self.ttl
        ]
        for key in expired:
            del self._tracks[key]

        candidates = sorted(
            (
                (_iou(detection.bbox, track.bbox), track_id, index)
                for track_id, track in self._tracks.items()
                if track.present
                for index, detection in enumerate(detections)
            ),
            reverse=True,
        )
        matched_tracks: set[int] = set()
        matched_detections: set[int] = set()
        matches: dict[int, int] = {}
        for overlap, track_id, index in candidates:
            if overlap < 0.3:
                break
            if track_id not in matched_tracks and index not in matched_detections:
                matched_tracks.add(track_id)
                matched_detections.add(index)
                matches[index] = track_id

        for track_id, track in self._tracks.items():
            if track.present and track_id not in matched_tracks:
                track.present = False
                track.stable_identity = None
                track.candidate_identity = None
                track.candidate_count = 0

        reserved_tracks = set(matched_tracks)
        output: list[Detection] = []
        for index, detection in enumerate(detections):
            track_id = matches.get(index)
            if track_id is None:
                track_id = self._new_track(detection.bbox, timestamp, reserved_tracks)
                if track_id is None:
                    output.append(replace(detection, identity=None))
                    continue
                reserved_tracks.add(track_id)
            track = self._tracks[track_id]
            if not track.present:
                # A gap ends the old identity run even if the box returns in place.
                track.stable_identity = None
                track.candidate_identity = None
                track.candidate_count = 0
            track.present = True
            track.bbox = detection.bbox
            track.last_seen = timestamp
            output.append(replace(detection, identity=self._confirm(track, detection.identity)))

        return output

    def clear(self) -> None:
        self._tracks.clear()

    def _new_track(
        self, bbox: tuple[float, float, float, float], now: float, reserved: set[int]
    ) -> int | None:
        if len(self._tracks) >= self.max_tracks:
            evictable = [key for key in self._tracks if key not in reserved]
            if not evictable:
                return None
            oldest_id = min(evictable, key=lambda key: self._tracks[key].last_seen)
            del self._tracks[oldest_id]
        track_id = self._next_id
        self._next_id += 1
        self._tracks[track_id] = _Track(bbox=bbox, last_seen=now, present=False)
        return track_id

    def _confirm(self, track: _Track, identity: str | None) -> str | None:
        if identity is None:
            track.candidate_identity = None
            track.candidate_count = 0
            return None
        if identity == track.stable_identity:
            track.candidate_identity = None
            track.candidate_count = 0
            return identity
        if identity == track.candidate_identity:
            track.candidate_count += 1
        else:
            track.candidate_identity = identity
            track.candidate_count = 1
        required = (
            self.confirmations if track.stable_identity is None else self.switch_confirmations
        )
        if track.candidate_count >= required:
            track.stable_identity = identity
            track.candidate_identity = None
            track.candidate_count = 0
            return identity
        return None


def _iou(
    first: tuple[float, float, float, float], second: tuple[float, float, float, float]
) -> float:
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    if intersection == 0:
        return 0.0
    first_area = max(0.0, first[2] - first[0]) * max(0.0, first[3] - first[1])
    second_area = max(0.0, second[2] - second[0]) * max(0.0, second[3] - second[1])
    union = first_area + second_area - intersection
    return intersection / union if union else 0.0
