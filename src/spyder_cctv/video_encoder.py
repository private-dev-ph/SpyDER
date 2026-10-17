"""Bounded local H.264 encoder. No shell, uploads or runtime downloads."""

import subprocess
import tempfile
from pathlib import Path

import imageio_ffmpeg


class H264Writer:
    def __init__(self, path: Path, profile: dict):
        self._errors = tempfile.TemporaryFile()
        self._process = None
        fps = profile["fps"]
        bitrate = profile["bitrate_kbps"]
        command = [
            imageio_ffmpeg.get_ffmpeg_exe(),
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "-s:v",
            f"{profile['width']}x{profile['height']}",
            "-r",
            str(fps),
            "-i",
            "pipe:0",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-threads",
            "2",
            "-pix_fmt",
            "yuv420p",
            "-b:v",
            f"{bitrate}k",
            "-maxrate",
            f"{bitrate}k",
            "-bufsize",
            f"{bitrate * 2}k",
            "-g",
            str(fps * 2),
            "-movflags",
            "+faststart",
            str(path),
        ]
        try:
            self._process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=self._errors,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception:
            self._errors.close()
            raise

    def write(self, frame):
        if self._process is None or self._process.poll() is not None:
            raise RuntimeError("Local H.264 encoder stopped unexpectedly")
        self._process.stdin.write(frame.tobytes())

    def release(self):
        process, self._process = self._process, None
        if process is None:
            return
        try:
            try:
                process.stdin.close()
            except BrokenPipeError:
                pass
            try:
                code = process.wait(timeout=10)
            except subprocess.TimeoutExpired as error:
                process.kill()
                process.wait()
                raise RuntimeError("Local H.264 encoder did not finish") from error
            if code:
                self._errors.seek(0)
                detail = self._errors.read(1500).decode("utf-8", errors="replace")
                raise RuntimeError(f"Local H.264 encoder failed: {detail}")
        finally:
            self._errors.close()
