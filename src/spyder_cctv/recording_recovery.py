"""Local recording leases and bounded-memory recovery of fragmented MP4 files."""

import logging
import os
import struct
from pathlib import Path

import cv2

logger = logging.getLogger(__name__)


class RecordingLease:
    """An OS-released lock prevents recovery or recording over a live writer."""

    def __init__(self, directory: Path):
        self.path = directory / ".recording.lock"
        self.stream = None

    def acquire(self):
        if self.stream is not None:
            raise RuntimeError("A recording writer already holds this folder")
        if self.path.is_symlink():
            raise RuntimeError("Recording lock must not be a symbolic link")
        stream = self.path.open("a+b")
        try:
            if self.path.stat().st_size == 0:
                stream.write(b"0")
                stream.flush()
            stream.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            stream.close()
            raise RuntimeError("Another recording instance is using this output folder") from error
        self.stream = stream

    def release(self):
        stream, self.stream = self.stream, None
        if stream is None:
            return
        try:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        except OSError:
            logger.warning("Recording lock unlock failed; closing its handle", exc_info=True)
        finally:
            try:
                stream.close()
            except OSError:
                logger.warning("Recording lock close failed", exc_info=True)


def process_identity(pid):
    if type(pid) is not int or pid <= 0:
        return False, None
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel.GetProcessTimes.argtypes = (
            wintypes.HANDLE,
            *([ctypes.POINTER(wintypes.FILETIME)] * 4),
        )
        handle = kernel.OpenProcess(0x100000 | 0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() != 87, None
        try:
            alive = kernel.WaitForSingleObject(handle, 0) != 0
            times = [wintypes.FILETIME() for _ in range(4)]
            ok = kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in times))
            birth = str(times[0].dwHighDateTime << 32 | times[0].dwLowDateTime) if ok else None
            return alive, birth
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False, None
    except PermissionError:
        return True, None
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().split(") ", 1)[1].split()
        return fields[0] != "Z", fields[19]
    except (OSError, IndexError):
        return True, None


def encoder_running(metadata):
    alive, birth = process_identity(metadata.get("encoder_pid"))
    recorded = metadata.get("encoder_birth")
    return alive and (not recorded or not birth or recorded == birth)


def sync_file(path):
    with path.open("r+b") as stream:
        stream.flush()
        os.fsync(stream.fileno())


def sync_directory(path):
    if hasattr(os, "O_DIRECTORY"):
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def complete_fragment_end(path):
    """Parse box headers without loading a multi-hour recording into memory."""
    size = path.stat().st_size
    position = 0
    last_good = 0
    has_header = False
    has_fragment = False
    pending_fragment = False
    with path.open("rb") as stream:
        while position + 8 <= size:
            stream.seek(position)
            header = stream.read(8)
            if len(header) != 8:
                break
            length, kind = struct.unpack(">I4s", header)
            header_size = 8
            if length == 1:
                extended = stream.read(8)
                if len(extended) != 8:
                    break
                length = struct.unpack(">Q", extended)[0]
                header_size = 16
            if length < header_size or position + length > size:
                break
            if kind == b"moov":
                has_header = True
            elif kind == b"moof" and has_header:
                pending_fragment = True
            elif kind == b"mdat" and has_header and pending_fragment:
                has_fragment = True
                pending_fragment = False
                last_good = position + length
            elif has_fragment and not pending_fragment:
                last_good = position + length
            position += length
    if not has_fragment:
        raise ValueError("No complete video fragment is available yet")
    return last_good


def recover_fragmented_file(path):
    """Keep the original tail separately before truncating an incomplete fragment."""
    # If an orphan encoder is still draining its closed input pipe, retry next startup.
    before = path.stat()
    end = complete_fragment_end(path)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise RuntimeError("Recording is still being written; recovery deferred")
    payload = None
    if end < after.st_size:
        tail = path.with_name(path.name + ".interrupted-tail")
        if after.st_size - end > 16 * 1024 * 1024:
            raise ValueError("Large uncertain tail retained; manual review required")
        with path.open("rb") as source:
            source.seek(end)
            payload = source.read(16 * 1024 * 1024 + 1)
        if tail.exists():
            if tail.stat().st_size != len(payload) or tail.read_bytes() != payload:
                raise RuntimeError("Existing interruption tail differs; original retained")
        else:
            temporary = tail.with_name(tail.name + ".tmp")
            with temporary.open("wb") as destination:
                destination.write(payload)
                destination.flush()
                os.fsync(destination.fileno())
            os.replace(temporary, tail)
            sync_directory(path.parent)
        with path.open("r+b") as stream:
            stream.truncate(end)
            stream.flush()
            os.fsync(stream.fileno())
    video = cv2.VideoCapture(str(path))
    try:
        fps = video.get(cv2.CAP_PROP_FPS)
        count = video.get(cv2.CAP_PROP_FRAME_COUNT)
        ok, frame = video.read()
        if not ok or fps <= 0 or count <= 0:
            raise ValueError("Interrupted video cannot be decoded; source retained")
        return {
            "duration_seconds": round(count / fps, 3),
            "fps": fps,
            "width": frame.shape[1],
            "height": frame.shape[0],
        }
    except (ValueError, cv2.error):
        # Validation failure must leave the original source byte-for-byte intact.
        video.release()
        if payload is not None:
            with path.open("r+b") as stream:
                stream.seek(end)
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
        raise
    finally:
        video.release()
