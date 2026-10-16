"""Isolated, resource-bounded JavaScript workflow code execution."""

from __future__ import annotations

import json
from typing import Any

from . import workflow_code as _code

_MEMORY_LIMIT = 8 * 1024 * 1024
_TIME_LIMIT_SECONDS = 0.1
_STACK_LIMIT = 256 * 1024


def _quickjs_module():
    try:
        import quickjs
    except ImportError:
        raise RuntimeError(
            "JavaScript code requires optional dependency 'quickjs-ng>=0.17.0.1' "
            "(Python import name: quickjs)"
        ) from None
    return quickjs


def _source(source: Any) -> str:
    if not isinstance(source, str):
        raise ValueError("Code source must be text of at most 8000 bytes")
    try:
        too_large = len(source.encode("utf-8")) > _code.MAX_SOURCE
    except UnicodeEncodeError:
        raise ValueError("Code source must be valid UTF-8 text") from None
    if too_large:
        raise ValueError("Code source must be text of at most 8000 bytes")
    return source


def _new_context():
    ctx = _quickjs_module().Context()
    ctx.set_memory_limit(_MEMORY_LIMIT)
    ctx.set_max_stack_size(_STACK_LIMIT)
    ctx.set_time_limit(_TIME_LIMIT_SECONDS)
    return ctx


def _wrapped_source(source: str) -> str:
    # Keep source inside a JSON string so it cannot escape the compile-only wrapper.
    body = "'use strict'; let output = null;\n" + source + "\nreturn output;"
    return "Function('detections', 'context', " + json.dumps(body, ensure_ascii=True) + ")"


def validate_javascript(source: str) -> None:
    """Check source size and JavaScript syntax without running user code."""
    source = _source(source)
    try:
        _new_context().eval(_wrapped_source(source))
    except Exception as exc:
        if "requires optional dependency" in str(exc):
            raise
        raise ValueError("Code source has invalid JavaScript syntax") from None


def run_javascript(
    source: str, detections: list[dict[str, Any]], context: dict[str, Any]
) -> list[dict[str, Any]]:
    """Run JavaScript in QuickJS with no host callbacks or host APIs exposed."""
    source = _source(source)
    validate_javascript(source)
    import time

    deadline = time.monotonic() + _TIME_LIMIT_SECONDS
    safe_detections, safe_context = _code._prepare_inputs(detections, context, deadline)
    # QuickJS receives only JSON text. No Python callable crosses into the JS runtime.
    data = json.dumps(
        {"detections": safe_detections, "context": safe_context},
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
    )
    script = (
        "const __data = JSON.parse(" + json.dumps(data) + ");\n"
        "(function freeze(value) { if (value && typeof value === 'object') { "
        "Object.values(value).forEach(freeze); Object.freeze(value); } })(__data.context);\n"
        "const __workflow = " + _wrapped_source(source) + ";\n"
        "const __result = __workflow(__data.detections, __data.context);\n"
        "if (__result === undefined) throw new TypeError('output is undefined');\n"
        "const __serialized = JSON.stringify(__result);\n"
        "if (typeof __serialized !== 'string') throw new TypeError('output is not JSON data');\n"
        "__serialized;"
    )
    try:
        encoded = _new_context().eval(script)
        output = json.loads(encoded)
        return _code._normalize_output(output)
    except _code.CodeError:
        raise
    except Exception as exc:
        message = str(exc).lower()
        if "interrupted" in message or "time limit" in message or "memory" in message:
            raise _code.CodeError("JavaScript exceeded 100 ms or 8 MiB resource limit") from None
        raise _code.CodeError("JavaScript code failed while processing data") from None
