"""Conservative local recording presets; estimates exclude container overhead."""

PROFILES = {
    "archive": {
        "label": "Archive · least detail",
        "width": 640,
        "height": 360,
        "fps": 3,
        "bitrate_kbps": 64,
    },
    "efficient": {
        "label": "Efficient · everyday",
        "width": 1280,
        "height": 720,
        "fps": 8,
        "bitrate_kbps": 256,
    },
    "detail": {
        "label": "Detail · larger files",
        "width": 1920,
        "height": 1080,
        "fps": 15,
        "bitrate_kbps": 2000,
    },
}
DEFAULT_SETTINGS = {"profile": "efficient", "segment_minutes": 15}


def validate_settings(value):
    if not isinstance(value, dict) or set(value) != {"profile", "segment_minutes"}:
        raise ValueError("Send profile and segment_minutes")
    if not isinstance(value["profile"], str) or value["profile"] not in PROFILES:
        raise ValueError("Unknown recording profile")
    if type(value["segment_minutes"]) is not int or value["segment_minutes"] not in (5, 15, 30, 60):
        raise ValueError("Clip length must be 5, 15, 30 or 60 minutes")
    return dict(value)


def describe_settings(settings):
    profile = PROFILES[settings["profile"]]
    bytes_per_second = profile["bitrate_kbps"] * 1000 / 8
    return {
        **settings,
        **profile,
        "codec": "H.264",
        "container": "MP4",
        "estimated_day_bytes": round(bytes_per_second * 86400),
        "estimated_clip_bytes": round(bytes_per_second * settings["segment_minutes"] * 60),
    }
