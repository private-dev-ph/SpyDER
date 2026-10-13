"""Portable control values and native-driver range conversion."""

import math
from typing import Any, Protocol

CONTROL_LABELS = {
    "zoom": "Zoom",
    "fov": "Field of view",
    "pan": "Pan",
    "tilt": "Tilt",
    "brightness": "Brightness",
    "contrast": "Contrast",
    "saturation": "Saturation",
}


def validate_settings(settings: object) -> dict[str, float]:
    if not isinstance(settings, dict) or not set(settings).issubset(CONTROL_LABELS):
        raise ValueError("Settings must contain known camera controls")
    result = {}
    for name, value in settings.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("Control values must be numbers")
        if not math.isfinite(value) or not 0 <= value <= 100:
            raise ValueError("Control values must be between 0 and 100 percent")
        result[name] = float(value)
    return result


def unavailable_controls(reason: str = "Not exposed by this camera backend") -> dict[str, Any]:
    return {
        name: {"label": label, "supported": False, "reason": reason}
        for name, label in CONTROL_LABELS.items()
    }


def describe_control(
    name: str,
    minimum: int,
    maximum: int,
    step: int,
    default: int,
    current: int,
    mode: str = "manual",
) -> dict[str, Any]:
    if maximum <= minimum or step <= 0:
        raise ValueError("Driver returned an unusable control range")
    percent = min(100.0, max(0.0, 100.0 * (current - minimum) / (maximum - minimum)))
    return {
        "label": CONTROL_LABELS[name],
        "supported": True,
        "value": round(percent, 3),
        "native_value": current,
        "minimum": minimum,
        "maximum": maximum,
        "step": step,
        "default": default,
        "mode": mode,
        "default_percent": round(100.0 * (default - minimum) / (maximum - minimum), 3),
    }


def native_value(percent: float, capability: dict[str, Any]) -> int:
    minimum, maximum, step = capability["minimum"], capability["maximum"], capability["step"]
    value = minimum + (maximum - minimum) * percent / 100.0
    maximum_step = (maximum - minimum) // step
    increments = min(maximum_step, max(0, round((value - minimum) / step)))
    return minimum + increments * step


class DeviceControls(Protocol):
    def capabilities(self) -> dict[str, Any]: ...
    def set_value(self, name: str, value: int) -> bool: ...
    def close(self) -> None: ...


def apply_settings(provider: DeviceControls, settings: dict[str, float]) -> dict[str, Any]:
    """Apply only supported controls; report quantization and rejected writes independently."""
    capabilities = provider.capabilities()
    results = {}
    for name, percent in validate_settings(settings).items():
        capability = capabilities.get(name, {})
        if not capability.get("supported"):
            results[name] = {"status": "unsupported", "requested": percent}
            continue
        try:
            value = native_value(percent, capability)
            accepted = provider.set_value(name, value)
            actual = provider.capabilities().get(name, {})
            if not accepted or not actual.get("supported"):
                status = "rejected"
            elif actual["native_value"] == value:
                status = "applied"
            else:
                status = "adjusted"
            results[name] = {
                "status": status,
                "requested": percent,
                "value": actual.get("value"),
                "native_value": actual.get("native_value"),
            }
        except Exception:
            results[name] = {"status": "failed", "requested": percent}
    return {"capabilities": provider.capabilities(), "results": results}
