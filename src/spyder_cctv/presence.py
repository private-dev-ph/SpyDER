"""Bounded browser presence leases for camera idle policy."""

import threading
import time


class PresenceLeases:
    """Track browser tabs with short leases and blur debounce."""

    def __init__(self, *, ttl: float = 15.0, inactive_grace: float = 2.0, limit: int = 128):
        self.ttl = ttl
        self.inactive_grace = inactive_grace
        self.limit = limit
        self._lock = threading.Lock()
        self._leases: dict[str, tuple[float, bool, bool, float | None]] = {}

    def heartbeat(self, client_id: str, active: bool, release_when_idle: bool) -> None:
        now = time.monotonic()
        with self._lock:
            self._expire(now)
            previous = self._leases.get(client_id)
            if previous is None and len(self._leases) >= self.limit:
                raise ValueError("Too many presence clients")
            inactive_since = None
            if not active:
                inactive_since = previous[3] if previous and not previous[1] else now
            self._leases[client_id] = (now + self.ttl, active, release_when_idle, inactive_since)

    def keeps_cameras(self, *, allow_opt_out: bool = True) -> bool:
        now = time.monotonic()
        with self._lock:
            self._expire(now)
            for _, active, release_when_idle, inactive_since in self._leases.values():
                if active:
                    return True
                if allow_opt_out and not release_when_idle:
                    return True
                if inactive_since is not None and now - inactive_since < self.inactive_grace:
                    return True
            return False

    def _expire(self, now: float) -> None:
        self._leases = {key: lease for key, lease in self._leases.items() if lease[0] > now}
