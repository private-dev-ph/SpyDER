"""Windows control-only DirectShow binding; never opens a second video stream.

The capture worker owns all COM interfaces, including creation and release. Only
documented IAMVideoProcAmp/IAMCameraControl properties are queried or modified.
"""

import ctypes as ct
import uuid
from typing import Any

from spyder_cctv.controls import describe_control, unavailable_controls


class GUID(ct.Structure):
    _fields_ = [
        ("data1", ct.c_uint32),
        ("data2", ct.c_uint16),
        ("data3", ct.c_uint16),
        ("data4", ct.c_ubyte * 8),
    ]

    @classmethod
    def parse(cls, value: str) -> "GUID":
        return cls.from_buffer_copy(uuid.UUID(value).bytes_le)


def _call(pointer: ct.c_void_p, index: int, argument_types: tuple, *arguments: Any) -> int:
    if not pointer:
        raise RuntimeError("Missing COM interface")
    table = ct.cast(pointer, ct.POINTER(ct.POINTER(ct.c_void_p))).contents
    method = ct.WINFUNCTYPE(ct.c_long, ct.c_void_p, *argument_types)(table[index])
    return method(pointer, *arguments)


def _release(pointer: ct.c_void_p) -> None:
    if pointer:
        _call(pointer, 2, ())


def _query(pointer: ct.c_void_p, interface_id: str) -> ct.c_void_p:
    result = ct.c_void_p()
    guid = GUID.parse(interface_id)
    code = _call(
        pointer, 0, (ct.POINTER(GUID), ct.POINTER(ct.c_void_p)), ct.byref(guid), ct.byref(result)
    )
    return result if code == 0 else ct.c_void_p()


class DirectShowControls:
    # IAMCameraControl: Pan=0, Tilt=1, Zoom=3. IAMVideoProcAmp: Brightness=0,
    # Contrast=1, Saturation=3. FOV is not part of either standard interface.
    properties = {
        "zoom": ("camera", 3),
        "pan": ("camera", 0),
        "tilt": ("camera", 1),
        "brightness": ("video", 0),
        "contrast": ("video", 1),
        "saturation": ("video", 3),
    }

    def __init__(self, device_index: int) -> None:
        self._interfaces: dict[str, ct.c_void_p] = {}
        self._filter = ct.c_void_p()
        # WinDLL leaves HRESULT handling explicit. OleDLL would raise before we can
        # accept RPC_E_CHANGED_MODE from OpenCV's already-initialized apartment.
        self._ole = ct.WinDLL("ole32")
        self._ole.CoInitializeEx.argtypes = (ct.c_void_p, ct.c_ulong)
        self._ole.CoInitializeEx.restype = ct.c_long
        code = self._ole.CoInitializeEx(None, 0)
        self._initialized = code in (0, 1)
        if code not in (0, 1, -2147417850):  # RPC_E_CHANGED_MODE: existing apartment is usable.
            raise RuntimeError("COM initialization failed")
        try:
            self._bind(device_index)
            self._interfaces["camera"] = _query(
                self._filter, "c6e13370-30ac-11d0-a18c-00a0c9118956"
            )
            self._interfaces["video"] = _query(self._filter, "c6e13360-30ac-11d0-a18c-00a0c9118956")
        except Exception:
            self.close()
            raise

    def _bind(self, device_index: int) -> None:
        enumerator, devices = ct.c_void_p(), ct.c_void_p()
        system = GUID.parse("62be5d10-60eb-11d0-bd3b-00a0c911ce86")
        interface = GUID.parse("29840822-5b84-11d0-bd3b-00a0c911ce86")
        category = GUID.parse("860bb310-5d01-11d0-bd3b-00a0c911ce86")
        base_filter = GUID.parse("56a86895-0ad4-11ce-b03a-0020af0ba770")
        self._ole.CoCreateInstance.argtypes = (
            ct.POINTER(GUID),
            ct.c_void_p,
            ct.c_ulong,
            ct.POINTER(GUID),
            ct.POINTER(ct.c_void_p),
        )
        self._ole.CoCreateInstance.restype = ct.c_long
        code = self._ole.CoCreateInstance(
            ct.byref(system), None, 1, ct.byref(interface), ct.byref(enumerator)
        )
        if code != 0:
            raise RuntimeError("Cannot enumerate camera controls")
        try:
            code = _call(
                enumerator,
                3,
                (ct.POINTER(GUID), ct.POINTER(ct.c_void_p), ct.c_ulong),
                ct.byref(category),
                ct.byref(devices),
                0,
            )
            if code != 0:
                raise RuntimeError("No camera control devices")
            for index in range(device_index + 1):
                moniker, fetched = ct.c_void_p(), ct.c_ulong()
                code = _call(
                    devices,
                    3,
                    (ct.c_ulong, ct.POINTER(ct.c_void_p), ct.POINTER(ct.c_ulong)),
                    1,
                    ct.byref(moniker),
                    ct.byref(fetched),
                )
                if code != 0 or fetched.value != 1:
                    raise RuntimeError("Camera control device not found")
                try:
                    if index == device_index:
                        code = _call(
                            moniker,
                            8,
                            (ct.c_void_p, ct.c_void_p, ct.POINTER(GUID), ct.POINTER(ct.c_void_p)),
                            None,
                            None,
                            ct.byref(base_filter),
                            ct.byref(self._filter),
                        )
                        if code != 0:
                            raise RuntimeError("Camera control interface unavailable")
                finally:
                    _release(moniker)
        finally:
            _release(devices)
            _release(enumerator)

    def capabilities(self) -> dict[str, Any]:
        result = unavailable_controls("Driver does not expose manual control")
        result["fov"]["reason"] = "FOV is not exposed by the standard camera driver interface"
        long_pointer = ct.POINTER(ct.c_long)
        for name, (family, property_id) in self.properties.items():
            interface = self._interfaces.get(family)
            if not interface:
                continue
            minimum, maximum, step, default, flags = [ct.c_long() for _ in range(5)]
            code = _call(
                interface,
                3,
                (ct.c_long,) + (long_pointer,) * 5,
                property_id,
                ct.byref(minimum),
                ct.byref(maximum),
                ct.byref(step),
                ct.byref(default),
                ct.byref(flags),
            )
            if code != 0 or not flags.value & 2:  # Manual mode must be supported.
                continue
            current, mode = ct.c_long(), ct.c_long()
            code = _call(
                interface,
                5,
                (ct.c_long, long_pointer, long_pointer),
                property_id,
                ct.byref(current),
                ct.byref(mode),
            )
            if code != 0:
                continue
            try:
                result[name] = describe_control(
                    name,
                    minimum.value,
                    maximum.value,
                    step.value,
                    default.value,
                    current.value,
                    "auto" if mode.value & 1 else "manual",
                )
            except ValueError:
                pass
        return result

    def set_value(self, name: str, value: int) -> bool:
        family, property_id = self.properties[name]
        return (
            _call(
                self._interfaces[family],
                4,
                (ct.c_long, ct.c_long, ct.c_long),
                property_id,
                value,
                2,
            )
            == 0
        )

    def close(self) -> None:
        for pointer in self._interfaces.values():
            _release(pointer)
        self._interfaces.clear()
        _release(self._filter)
        self._filter = ct.c_void_p()
        if self._initialized:
            self._ole.CoUninitialize()
            self._initialized = False
