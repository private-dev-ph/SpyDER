"""Run native file dialogs in an isolated process, away from HTTP worker threads."""

import argparse
import json
import os
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path

DIALOG_TIMEOUT_SECONDS = 600
PICKER_LOCK = threading.Lock()
_PROCESS_LOCK = threading.Lock()
_ACTIVE_PROCESS: subprocess.Popen | None = None
_DIALOG_KINDS = {"save_archive", "open_archive", "restore_parent"}


def _dialog(kind: str) -> str | None:
    """Open one native Windows dialog and return its selected path."""
    if kind not in _DIALOG_KINDS:
        raise ValueError("Unknown backup picker kind")
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as error:
        raise RuntimeError(
            "Native file selection is unavailable. Enter an absolute archive path manually."
        ) from error

    root = None
    initial_dir = Path.home() / "Documents"
    if not initial_dir.is_dir():
        initial_dir = Path.home()
    try:
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        root.update_idletasks()
        if kind == "save_archive":
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            selected = filedialog.asksaveasfilename(
                parent=root,
                initialdir=str(initial_dir),
                title="Save SpyDER backup",
                initialfile=f"SpyDER-Backup-{stamp}.zip",
                defaultextension=".zip",
                filetypes=(("ZIP archives", "*.zip"),),
                confirmoverwrite=False,
            )
        elif kind == "open_archive":
            selected = filedialog.askopenfilename(
                parent=root,
                initialdir=str(initial_dir),
                title="Open SpyDER backup",
                filetypes=(("ZIP archives", "*.zip"),),
                defaultextension=".zip",
            )
        else:
            selected = filedialog.askdirectory(
                parent=root,
                initialdir=str(initial_dir),
                title="Choose restore parent folder",
                mustexist=True,
            )
        return selected or None
    except Exception as error:
        raise RuntimeError(
            "Native file selection failed. Enter an absolute archive path manually."
        ) from error
    finally:
        if root is not None:
            try:
                root.destroy()
            except Exception:
                pass


def _validated_selection(kind: str, selected: str | None) -> str | None:
    if selected is None or selected == "":
        return None
    raw = Path(selected).expanduser()
    if not raw.is_absolute():
        raise RuntimeError("Native picker returned a non-absolute path")

    if kind == "save_archive":
        if raw.suffix.lower() != ".zip":
            raw = raw.with_suffix(raw.suffix + ".zip" if raw.suffix else ".zip")
        if os.path.lexists(raw):
            raise RuntimeError("Selected archive already exists; choose a new filename")
        parent = raw.parent.resolve(strict=True)
        if not parent.is_dir():
            raise RuntimeError("Selected archive parent folder does not exist")
        return str(parent / raw.name)

    resolved = raw.resolve(strict=True)
    if kind == "open_archive":
        if not resolved.is_file() or resolved.suffix.lower() != ".zip":
            raise RuntimeError("Select an existing ZIP archive")
        return str(resolved)

    if not resolved.is_dir():
        raise RuntimeError("Select an existing parent folder")
    child = resolved / "SpyDER-Restored"
    index = 2
    while os.path.lexists(child):
        child = resolved / f"SpyDER-Restored-{index}"
        index += 1
    return str(child)


def close_active_picker() -> None:
    """Terminate the isolated dialog process during server shutdown."""
    with _PROCESS_LOCK:
        process = _ACTIVE_PROCESS
        if process is None or process.poll() is not None:
            return
        try:
            process.kill()
        except OSError:
            return
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass


def choose_path(
    kind: str,
    *,
    popen_factory=subprocess.Popen,
    timeout: int = DIALOG_TIMEOUT_SECONDS,
    is_closing=None,
) -> str | None:
    """Run isolated native picker and validate its output before returning it."""
    global _ACTIVE_PROCESS
    if kind not in _DIALOG_KINDS:
        raise ValueError("Unknown backup picker kind")
    command = [sys.executable, "-m", "spyder_cctv.backup_picker", "--dialog", kind]
    options = {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE, "text": True}
    if sys.platform == "win32":
        options["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    with _PROCESS_LOCK:
        if is_closing is not None and is_closing():
            raise RuntimeError("SpyDER is closing")
        try:
            process = popen_factory(command, **options)
        except OSError as error:
            raise RuntimeError(
                "Native file selection is unavailable. Enter an absolute archive path manually."
            ) from error
        _ACTIVE_PROCESS = process
    try:
        try:
            stdout, _stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            process.kill()
            process.communicate()
            raise RuntimeError(
                "Native picker timed out. Enter an absolute archive path manually."
            ) from error
        if process.returncode != 0:
            message = "Native file selection failed. Enter an absolute archive path manually."
            try:
                payload = json.loads(stdout or "{}")
                if isinstance(payload, dict) and isinstance(payload.get("error"), str):
                    message = payload["error"][:240]
            except (TypeError, ValueError):
                pass
            raise RuntimeError(message)
        try:
            payload = json.loads(stdout)
        except (TypeError, ValueError) as error:
            raise RuntimeError("Native picker returned invalid data") from error
        if not isinstance(payload, dict) or set(payload) != {"path"}:
            raise RuntimeError("Native picker returned invalid data")
        selected = payload["path"]
        if selected is not None and not isinstance(selected, str):
            raise RuntimeError("Native picker returned invalid data")
        try:
            return _validated_selection(kind, selected)
        except (OSError, RuntimeError, ValueError) as error:
            if isinstance(error, RuntimeError):
                raise
            raise RuntimeError("Selected path is unavailable or invalid") from error
    finally:
        with _PROCESS_LOCK:
            if _ACTIVE_PROCESS is process:
                _ACTIVE_PROCESS = None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dialog", choices=sorted(_DIALOG_KINDS), required=True)
    args = parser.parse_args(argv)
    try:
        selected = _dialog(args.dialog)
        print(json.dumps({"path": selected}))
        return 0
    except Exception as error:
        print(json.dumps({"error": str(error)[:240]}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
