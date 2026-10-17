"""Bounded local H.264 encoder. No shell, uploads or runtime downloads."""

import math
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import cv2
import imageio_ffmpeg


class H264Writer:
    def __init__(self, path: Path, profile: dict):
        self.path = path
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
            "-tune",
            "zerolatency",
            "-bf",
            "0",
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
            "+frag_keyframe+empty_moov+default_base_moof",
            "-frag_duration",
            "2000000",
            "-flush_packets",
            "1",
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

    def checkpoint(self):
        if self.path.is_file():
            with self.path.open("r+b") as stream:
                os.fsync(stream.fileno())

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


def compress_recording(source, target, item, cancel):
    """Transcode once into a separate file; caller commits only validated savings."""
    if cancel.is_set():
        raise RuntimeError("Recording recompression cancelled")
    if shutil.disk_usage(source.parent).free < 64 * 1024 * 1024:
        raise RuntimeError("Insufficient temporary space for recompression")
    bitrate = 32 if item.get("bitrate_kbps", 256) <= 64 else 64
    fps = min(3, max(1, item.get("fps", 3)))
    command = [
        imageio_ffmpeg.get_ffmpeg_exe(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        f"scale=w='min(640,iw)':h='min(360,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps={fps}",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-threads",
        "1",
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
        str(target),
    ]
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=errors,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            deadline = time.monotonic() + 600
            while process.poll() is None:
                if shutil.disk_usage(source.parent).free < 64 * 1024 * 1024:
                    raise RuntimeError("Temporary recompression space exhausted")
                if cancel.wait(0.2) or time.monotonic() > deadline:
                    raise RuntimeError("Recording recompression cancelled or timed out")
            if process.returncode:
                raise RuntimeError("Recording recompression failed")
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
    video = cv2.VideoCapture(str(target))
    try:
        output_fps = video.get(cv2.CAP_PROP_FPS)
        duration = video.get(cv2.CAP_PROP_FRAME_COUNT) / output_fps if output_fps > 0 else 0
        ok, frame = video.read()
        if (
            not ok
            or not math.isfinite(duration)
            or abs(duration - item["duration_seconds"]) > max(1, 2 / fps)
        ):
            raise RuntimeError("Recompressed video failed playback/duration validation")
        return {
            "width": frame.shape[1],
            "height": frame.shape[0],
            "fps": output_fps,
            "bitrate_kbps": bitrate,
            "codec": "H.264",
        }
    finally:
        video.release()
