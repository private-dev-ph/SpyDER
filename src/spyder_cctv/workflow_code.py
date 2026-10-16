"""Bounded interpreter for workflow code nodes. Never executes Python bytecode."""

from __future__ import annotations

import ast
import copy
import math
import operator
import time
from typing import Any

MAX_SOURCE = 8000
MAX_NODES = 1000
MAX_STEPS = 10000
MAX_DETECTIONS = 500
MAX_STRING = 512
_FIELDS = {
    "label",
    "bbox",
    "confidence",
    "class_id",
    "score",
    "identity",
    "similarity",
    "identity_confidence",
}


class CodeError(ValueError, RuntimeError):
    """Safe user-facing validation and interpreter error."""


def _parse(source: Any) -> ast.Module:
    if not isinstance(source, str):
        raise ValueError("Code source must be text of at most 8000 bytes")
    try:
        too_large = len(source.encode("utf-8")) > MAX_SOURCE
    except UnicodeEncodeError:
        raise ValueError("Code source must be valid UTF-8 text") from None
    if too_large:
        raise ValueError("Code source must be text of at most 8000 bytes")
    try:
        tree = ast.parse(source, mode="exec")
    except (SyntaxError, ValueError, RecursionError):
        raise ValueError("Code source has invalid Python syntax") from None
    if sum(1 for _ in ast.walk(tree)) > MAX_NODES:
        raise ValueError("Code exceeds 1000 syntax nodes")
    return tree


def _validate_python_code(source: str) -> None:
    """Validate workflow Python subset; raise ValueError with actionable message."""
    tree = _parse(source)
    try:
        for node in ast.walk(tree):
            if not isinstance(node, _ALLOWED_NODES):
                raise ValueError(f"Unsupported code syntax: {type(node).__name__}")
            if isinstance(node, ast.Name) and (
                node.id.startswith("_")
                or node.id
                in {
                    "eval",
                    "exec",
                    "open",
                    "compile",
                    "globals",
                    "locals",
                    "getattr",
                    "setattr",
                    "input",
                    "__import__",
                }
            ):
                raise ValueError("Private or unsafe names are not allowed")
            if isinstance(node, ast.Constant):
                if isinstance(node.value, int) and abs(node.value) > 10**12:
                    raise ValueError("Numeric constants exceed safe bounds")
                if isinstance(node.value, str) and len(node.value) > MAX_STRING:
                    raise ValueError("String constants exceed 512 characters")
            if isinstance(node, ast.Attribute) and node.attr not in {"get", "append"}:
                raise ValueError("Only dict.get and list.append are allowed")
            if isinstance(node, (ast.Assign, ast.AugAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                if any(_root_name(target) == "context" for target in targets):
                    raise ValueError("context is read-only")
            if isinstance(node, (ast.Assign, ast.AugAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                if any(_root_name(target) == "context" for target in targets):
                    raise ValueError("context is read-only")
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id not in {
                    "len",
                    "min",
                    "max",
                    "abs",
                    "round",
                }:
                    raise ValueError("Only len, min, max, abs and round calls are allowed")
                if isinstance(node.func, ast.Attribute) and node.func.attr not in {"get", "append"}:
                    raise ValueError("Only dict.get and list.append are allowed")
                if (
                    isinstance(node.func, ast.Attribute)
                    and node.func.attr == "append"
                    and _root_name(node.func.value) == "context"
                ):
                    raise ValueError("context is read-only")
                if (
                    isinstance(node.func, ast.Attribute)
                    and node.func.attr == "append"
                    and _root_name(node.func.value) == "context"
                ):
                    raise ValueError("context is read-only")
                if not isinstance(node.func, (ast.Name, ast.Attribute)):
                    raise ValueError("Unsupported function call")
            if isinstance(node, ast.BinOp) and not isinstance(
                node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod)
            ):
                raise ValueError("Unsupported arithmetic operator")
        for statement in tree.body:
            if not isinstance(
                statement, (ast.Assign, ast.AugAssign, ast.Expr, ast.If, ast.For, ast.Pass)
            ):
                raise ValueError("Only assignments, expressions, if, for and pass are allowed")
    except ValueError:
        raise


_ALLOWED_NODES = (
    ast.Module,
    ast.Assign,
    ast.AugAssign,
    ast.Expr,
    ast.If,
    ast.For,
    ast.Pass,
    ast.Name,
    ast.Load,
    ast.Store,
    ast.Constant,
    ast.List,
    ast.Tuple,
    ast.Dict,
    ast.Subscript,
    ast.Slice,
    ast.IfExp,
    ast.Compare,
    ast.BoolOp,
    ast.UnaryOp,
    ast.BinOp,
    ast.Call,
    ast.Attribute,
    ast.ListComp,
    ast.comprehension,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.FloorDiv,
    ast.Mod,
    ast.USub,
    ast.UAdd,
    ast.Not,
    ast.And,
    ast.Or,
    ast.Eq,
    ast.NotEq,
    ast.Lt,
    ast.LtE,
    ast.Gt,
    ast.GtE,
    ast.In,
    ast.NotIn,
)


def _root_name(node: ast.AST) -> str | None:
    while isinstance(node, (ast.Subscript, ast.Attribute)):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


def validate_code(source: str, language: str = "python") -> None:
    """Validate code node source without running user code."""
    if language == "python":
        return _validate_python_code(source)
    if language == "javascript":
        from .workflow_javascript import validate_javascript

        return validate_javascript(source)
    raise ValueError("Code language must be python or javascript")


def _bounded(value: Any, deadline: float | None = None) -> Any:
    return _check_value(value, set(), set(), 0, [0], deadline)


def _scalar(value: Any) -> bool:
    return value is None or type(value) in (bool, int, float, str)


def _flat_sequence(value: Any) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) <= MAX_DETECTIONS
        and all(_scalar(item) for item in value)
    )


def _validate_detection(item: Any) -> None:
    if (
        not isinstance(item, dict)
        or set(item) - _FIELDS
        or not isinstance(item.get("label"), str)
        or not item["label"]
        or len(item["label"]) > 128
    ):
        raise CodeError("Each detection needs label and known detection fields")
    bbox = item.get("bbox")
    if (
        not isinstance(bbox, (list, tuple))
        or len(bbox) != 4
        or any(type(value) not in (int, float) or not math.isfinite(value) for value in bbox)
        or bbox[2] < bbox[0]
        or bbox[3] < bbox[1]
    ):
        raise CodeError("bbox must contain four ordered finite numbers")
    for key in ("confidence", "score", "similarity", "identity_confidence"):
        value = item.get(key)
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value)):
            raise CodeError(f"{key} must be a finite number")
    if item.get("confidence") is not None and not 0 <= item["confidence"] <= 1:
        raise CodeError("confidence must be between 0 and 1")
    if item.get("identity_confidence") is not None and not 0 <= item["identity_confidence"] <= 1:
        raise CodeError("identity_confidence must be between 0 and 1")
    if item.get("similarity") is not None and not -1 <= item["similarity"] <= 1:
        raise CodeError("similarity must be between -1 and 1")
    if "class_id" in item and item["class_id"] is not None and type(item["class_id"]) is not int:
        raise CodeError("class_id must be an integer or null")
    if (
        "identity" in item
        and item["identity"] is not None
        and (
            not isinstance(item["identity"], str)
            or not item["identity"]
            or len(item["identity"]) > 128
        )
    ):
        raise CodeError("identity must be non-empty text or null")


def _check_value(
    value: Any,
    seen: set[int],
    active: set[int],
    depth: int,
    budget: list[int],
    deadline: float | None,
) -> Any:
    budget[0] += 1
    if budget[0] > 10000:
        raise CodeError("Value graph exceeds 10000 items")
    if budget[0] % 128 == 0 and deadline is not None and time.monotonic() > deadline:
        raise CodeError("Code exceeded 100 ms execution time")
    if depth > 16:
        raise CodeError("Value graph exceeds 16 levels")
    if value is None or type(value) is bool:
        return value
    if type(value) is int:
        if abs(value) > 10**12:
            raise CodeError("Numeric value exceeds safe bounds")
        return value
    if type(value) is float:
        if not math.isfinite(value) or abs(value) > 1e12:
            raise CodeError("Numeric value exceeds safe bounds")
        return value
    if isinstance(value, str):
        if len(value) > MAX_STRING:
            raise CodeError("String exceeds 512 characters")
        return value
    if isinstance(value, (list, tuple, dict)):
        ident = id(value)
        if ident in active:
            raise CodeError("Cyclic values are not allowed")
        if ident in seen:
            return value
        seen.add(ident)
        active.add(ident)
        if isinstance(value, list):
            if len(value) > MAX_DETECTIONS:
                raise CodeError("List exceeds 500 items")
            for item in value:
                _check_value(item, seen, active, depth + 1, budget, deadline)
        elif isinstance(value, tuple):
            if len(value) > MAX_DETECTIONS:
                raise CodeError("List exceeds 500 items")
            for item in value:
                _check_value(item, seen, active, depth + 1, budget, deadline)
        else:
            if len(value) > 100:
                raise CodeError("Dictionary exceeds 100 fields")
            for key, item in value.items():
                if not isinstance(key, str) or len(key) > MAX_STRING:
                    raise CodeError("Dictionary keys must be short text")
                _check_value(item, seen, active, depth + 1, budget, deadline)
        active.remove(ident)
        return value
    raise CodeError("Unsupported value type")


class _Interpreter:
    def __init__(self, tree: ast.Module, env: dict[str, Any], deadline: float):
        self.tree, self.env, self.steps = tree, env, 0
        self.deadline = deadline

    def step(self) -> None:
        self.steps += 1
        if self.steps > MAX_STEPS:
            raise CodeError("Code exceeded 10000 execution steps")
        if self.steps % 128 == 0 and time.monotonic() > self.deadline:
            raise CodeError("Code exceeded 100 ms execution time")

    def bounded(self, value: Any) -> Any:
        return _check_value(value, set(), set(), 0, [0], self.deadline)

    def binary(self, op: Any, a: Any, b: Any) -> Any:
        numeric = type(a) in (int, float) and type(b) in (int, float)
        sequence = (
            op in (operator.add, operator.mul)
            and type(a) in (str, list, tuple)
            and (type(b) is type(a) or (op is operator.mul and type(b) is int))
        )
        reverse_sequence = op is operator.mul and type(b) in (str, list, tuple) and type(a) is int
        if op is operator.mod and (isinstance(a, str) or isinstance(b, str)):
            raise CodeError("String formatting is not allowed")
        if not numeric and not sequence and not reverse_sequence:
            raise CodeError("Arithmetic requires bounded numbers or bounded sequence operations")
        if op is operator.add and isinstance(a, (str, list, tuple)) and isinstance(b, type(a)):
            limit = MAX_STRING if isinstance(a, str) else MAX_DETECTIONS
            if len(a) + len(b) > limit:
                raise CodeError("Combined value exceeds safe size limit")
        if op is operator.mul:
            if (
                isinstance(a, (str, list, tuple))
                and type(b) is int
                and len(a) * max(b, 0) > (MAX_STRING if isinstance(a, str) else MAX_DETECTIONS)
            ):
                raise CodeError("Repeated value exceeds safe size limit")
            if (
                isinstance(b, (str, list, tuple))
                and type(a) is int
                and len(b) * max(a, 0) > (MAX_STRING if isinstance(b, str) else MAX_DETECTIONS)
            ):
                raise CodeError("Repeated value exceeds safe size limit")
        return self.bounded(op(a, b))

    def expr(self, n: ast.AST) -> Any:
        self.step()
        if isinstance(n, ast.Constant):
            return self.bounded(n.value)
        if isinstance(n, ast.Name):
            if n.id not in self.env:
                raise CodeError(f"Unknown name: {n.id}")
            return self.env[n.id]
        if isinstance(n, (ast.List, ast.Tuple)):
            v = [self.expr(x) for x in n.elts]
            return v if isinstance(n, ast.List) else tuple(v)
        if isinstance(n, ast.Dict):
            return self.bounded(
                {self.expr(k): self.expr(v) for k, v in zip(n.keys, n.values, strict=True)}
            )
        if isinstance(n, ast.Subscript):
            return self.expr(n.value)[self.expr(n.slice)]
        if isinstance(n, ast.Slice):
            return slice(
                self.expr(n.lower) if n.lower else None,
                self.expr(n.upper) if n.upper else None,
                self.expr(n.step) if n.step else None,
            )
        if isinstance(n, ast.IfExp):
            return self.expr(n.body if self.expr(n.test) else n.orelse)
        if isinstance(n, ast.UnaryOp):
            v = self.expr(n.operand)
            return self.bounded(
                -v if isinstance(n.op, ast.USub) else +v if isinstance(n.op, ast.UAdd) else not v
            )
        if isinstance(n, ast.BinOp):
            a, b = self.expr(n.left), self.expr(n.right)
            op = {
                ast.Add: operator.add,
                ast.Sub: operator.sub,
                ast.Mult: operator.mul,
                ast.Div: operator.truediv,
                ast.FloorDiv: operator.floordiv,
                ast.Mod: operator.mod,
            }[type(n.op)]
            return self.binary(op, a, b)
        if isinstance(n, ast.BoolOp):
            result = self.expr(n.values[0])
            for x in n.values[1:]:
                if isinstance(n.op, ast.And) and not result or isinstance(n.op, ast.Or) and result:
                    break
                result = self.expr(x)
            return result
        if isinstance(n, ast.Compare):
            left = self.expr(n.left)
            for op, rhs in zip(n.ops, n.comparators, strict=True):
                right = self.expr(rhs)
                if not (
                    _scalar(left)
                    and _scalar(right)
                    or _flat_sequence(left)
                    and _flat_sequence(right)
                    or isinstance(op, (ast.In, ast.NotIn))
                    and _scalar(left)
                    and (isinstance(right, str) or _flat_sequence(right))
                ):
                    raise CodeError("Comparisons require scalar or flat values")
                fn = {
                    ast.Eq: operator.eq,
                    ast.NotEq: operator.ne,
                    ast.Lt: operator.lt,
                    ast.LtE: operator.le,
                    ast.Gt: operator.gt,
                    ast.GtE: operator.ge,
                    ast.In: lambda a, b: a in b,
                    ast.NotIn: lambda a, b: a not in b,
                }[type(op)]
                if not fn(left, right):
                    return False
                left = right
            return True
        if isinstance(n, ast.Attribute):
            return (self.expr(n.value), n.attr)
        if isinstance(n, ast.Call):
            args = [self.expr(x) for x in n.args]
            if isinstance(n.func, ast.Name):
                if n.func.id in {"min", "max"} and any(
                    isinstance(value, (list, tuple)) and not _flat_sequence(value) for value in args
                ):
                    raise CodeError("min and max require flat lists")
                fn = {"len": len, "min": min, "max": max, "abs": abs, "round": round}[n.func.id]
                return self.bounded(fn(*args))
            obj, method = self.expr(n.func)
            if method == "get" and isinstance(obj, dict):
                return obj.get(*args)
            if method == "append" and isinstance(obj, list) and len(args) == 1:
                if len(obj) >= MAX_DETECTIONS:
                    raise CodeError("List exceeds 500 items")
                obj.append(self.bounded(args[0]))
                self.bounded(obj)
                return None
            raise CodeError("Method is not allowed for this value")
        if isinstance(n, ast.ListComp):
            out = []

            def gen(i: int) -> None:
                self.step()
                if i == len(n.generators):
                    out.append(self.bounded(self.expr(n.elt)))
                    if len(out) > MAX_DETECTIONS:
                        raise CodeError("List exceeds 500 items")
                    return
                g = n.generators[i]
                for val in self.expr(g.iter):
                    self.assign(g.target, val)
                    if all(self.expr(c) for c in g.ifs):
                        gen(i + 1)

            gen(0)
            return out
        raise CodeError("Unsupported expression")

    def assign(self, target: ast.AST, value: Any) -> None:
        self.step()
        self.bounded(value)
        if isinstance(target, ast.Name):
            if target.id.startswith("_"):
                raise CodeError("Private names are not allowed")
            self.env[target.id] = value
        elif isinstance(target, (ast.List, ast.Tuple)):
            if len(target.elts) != len(value):
                raise CodeError("Cannot unpack assignment")
            for t, v in zip(target.elts, value, strict=True):
                self.assign(t, v)
        elif isinstance(target, ast.Subscript):
            container = self.expr(target.value)
            container[self.expr(target.slice)] = value
            self.bounded(container)
        else:
            raise CodeError("Unsupported assignment target")

    def block(self, body: list[ast.stmt]) -> None:
        for n in body:
            self.step()
            if isinstance(n, ast.Assign):
                value = self.expr(n.value)
                for target in n.targets:
                    self.assign(target, value)
            elif isinstance(n, ast.AugAssign):
                a, b = self.expr(n.target), self.expr(n.value)
                op = {
                    ast.Add: operator.add,
                    ast.Sub: operator.sub,
                    ast.Mult: operator.mul,
                    ast.Div: operator.truediv,
                    ast.FloorDiv: operator.floordiv,
                    ast.Mod: operator.mod,
                }[type(n.op)]
                self.assign(n.target, self.binary(op, a, b))
            elif isinstance(n, ast.Expr):
                self.expr(n.value)
            elif isinstance(n, ast.If):
                self.block(n.body if self.expr(n.test) else n.orelse)
            elif isinstance(n, ast.For):
                values = self.expr(n.iter)
                if not isinstance(values, (list, tuple, str)) or len(values) > MAX_DETECTIONS:
                    raise CodeError("For loops require a list of at most 500 items")
                for value in values:
                    self.assign(n.target, value)
                    self.block(n.body)
                self.block(n.orelse)
            elif not isinstance(n, ast.Pass):
                raise CodeError("Unsupported statement")


def _prepare_inputs(
    detections: list[dict[str, Any]], context: dict[str, Any], deadline: float
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not isinstance(detections, list) or len(detections) > MAX_DETECTIONS:
        raise ValueError("Input detections must be a list of at most 500 items")
    if not isinstance(context, dict) or set(context) - {
        "camera_id",
        "engine",
        "frame_size",
        "sequence",
    }:
        raise ValueError("Context may contain only camera_id, engine, frame_size and sequence")
    if "camera_id" in context and (
        not isinstance(context["camera_id"], str) or len(context["camera_id"]) > 64
    ):
        raise ValueError("camera_id must be text of at most 64 characters")
    if "engine" in context and context["engine"] not in ("opencv", "yolo", "insightface"):
        raise ValueError("engine must be opencv, yolo or insightface")
    if "sequence" in context and (type(context["sequence"]) is not int or context["sequence"] < 0):
        raise ValueError("sequence must be a non-negative integer")
    if "frame_size" in context and (
        not isinstance(context["frame_size"], list)
        or len(context["frame_size"]) != 2
        or any(type(v) is not int or not 1 <= v <= 16384 for v in context["frame_size"])
    ):
        raise ValueError("frame_size must contain two integers between 1 and 16384")
    try:
        detections = copy.deepcopy(detections)
        context = copy.deepcopy(context)
        _bounded(detections, deadline)
        _bounded(context, deadline)
        for item in detections:
            _validate_detection(item)
    except CodeError:
        raise
    except Exception:
        raise CodeError("Input data is invalid or exceeds safe limits") from None
    safe_context = {
        k: context[k] for k in ("camera_id", "engine", "frame_size", "sequence") if k in context
    }
    return detections, _bounded(safe_context)


def _normalize_output(output: Any) -> list[dict[str, Any]]:
    if not isinstance(output, list) or len(output) > MAX_DETECTIONS:
        raise CodeError("output must be a list of at most 500 detections")
    clean = []
    for item in output:
        _validate_detection(item)
        clean.append(
            {k: list(v) if k == "bbox" and isinstance(v, tuple) else v for k, v in item.items()}
        )
    _bounded(clean)
    return clean


def run_code(
    source: str,
    detections: list[dict[str, Any]],
    context: dict[str, Any],
    language: str = "python",
) -> list[dict[str, Any]]:
    """Run source against bounded data and return valid, known detection fields."""
    if language == "javascript":
        from .workflow_javascript import run_javascript

        return run_javascript(source, detections, context)
    if language != "python":
        raise ValueError("Code language must be python or javascript")
    deadline = time.monotonic() + 0.1
    validate_code(source)
    detections, safe_context = _prepare_inputs(detections, context, deadline)
    env = {"detections": detections, "context": _bounded(safe_context), "output": None}
    try:
        tree = _parse(source)
        _Interpreter(tree, env, deadline).block(tree.body)
        return _normalize_output(env["output"])
    except (RuntimeError, ValueError) as exc:
        raise CodeError(str(exc)) from None
    except Exception:
        raise CodeError("Code failed while processing data") from None
