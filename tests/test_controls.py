import math
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

from spyder_cctv.controls import (
    apply_settings,
    describe_control,
    native_value,
    unavailable_controls,
    validate_settings,
)


@pytest.mark.parametrize(
    "settings",
    [
        None,
        [],
        {"unknown": 50},
        {"zoom": True},
        {"pan": -1},
        {"brightness": 101},
        {"fov": math.nan},
    ],
)
def test_invalid_percent_settings(settings):
    with pytest.raises(ValueError):
        validate_settings(settings)


def test_percent_mapping_quantizes_to_real_driver_steps():
    capability = describe_control("pan", -10, 10, 1, 0, 1)
    assert capability["value"] == 55
    assert native_value(33, capability) == -3
    assert native_value(0, capability) == -10
    assert native_value(100, capability) == 10
    irregular = describe_control("contrast", 0, 10, 3, 0, 0)
    assert native_value(100, irregular) == 9  # Never exceed the valid stepped range.


def test_set_result_requires_driver_readback_and_handles_unsupported_controls():
    class Provider:
        def capabilities(self):
            controls = unavailable_controls()
            controls["brightness"] = describe_control("brightness", 0, 255, 1, 128, 128)
            controls["zoom"] = describe_control("zoom", 100, 500, 1, 100, 100)
            return controls

        def set_value(self, name, value):
            return name != "brightness"  # Zoom pretends to accept but ignores the write.

    outcome = apply_settings(Provider(), {"brightness": 80, "zoom": 20, "fov": 50})
    assert outcome["results"]["brightness"]["status"] == "rejected"
    assert outcome["results"]["zoom"]["status"] == "adjusted"
    assert outcome["results"]["zoom"]["native_value"] == 100
    assert outcome["results"]["fov"]["status"] == "unsupported"


@pytest.mark.skipif(sys.platform != "win32", reason="Windows COM apartment regression")
def test_controls_accept_existing_capture_thread_com_apartment(monkeypatch):
    import ctypes as ct

    from spyder_cctv.directshow import DirectShowControls

    monkeypatch.setattr(DirectShowControls, "_bind", lambda self, index: None)
    monkeypatch.setattr("spyder_cctv.directshow._query", lambda *args: ct.c_void_p())

    def in_sta_thread():
        ole = ct.WinDLL("ole32")
        ole.CoInitializeEx.restype = ct.c_long
        assert ole.CoInitializeEx(None, 2) in (0, 1)
        try:
            controls = DirectShowControls(0)
            assert not controls._initialized  # Preserve the existing STA owner.
            controls.close()
        finally:
            ole.CoUninitialize()

    with ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(in_sta_thread).result(timeout=3)
