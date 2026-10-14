import threading
import time

from spyder_cctv.capacity import CapacityAssessment


class Manager:
    def __init__(self, statuses=None):
        self._statuses = statuses or []

    def statuses(self):
        return self._statuses


def wait_for(assessment, state, timeout=2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = assessment.snapshot()
        if result["state"] == state:
            return result
        time.sleep(0.005)
    raise AssertionError(f"Assessment did not reach {state}")


def test_capacity_report_uses_measured_cost_and_memory_cap():
    manager = Manager(
        [
            {
                "analysis_enabled": True,
                "metadata": {"analysis": {"processing_ms": 20, "inference_fps": 5}},
            },
            {"metadata": {"cv": {"inference_ms": 10}}, "inference_fps": 2},
            {"metadata": {"cv": {"inference_ms": 5}}, "inference_fps": 4},
        ]
    )
    assessment = CapacityAssessment(
        manager,
        hardware_provider=lambda: {"logical_cpus": 32, "memory_bytes": 128 << 20},
        benchmark=lambda: [
            {"name": "MOG2", "cost_ms": 20},
            {"name": "Motion regions", "cost_ms": 0.1},
            {"name": "MIL tracking", "cost_ms": 100},
        ],
    )
    assessment.start()
    result = wait_for(assessment, "ready")
    report = result["report"]

    assert report["hardware"] == {"logical_cpus": 32, "memory_bytes": 128 << 20}
    assert [p["name"] for p in report["profiles"]] == [
        "MOG2",
        "Motion regions",
        "MIL tracking",
    ]
    assert report["profiles"][0]["suggested_instances"] == 1
    assert report["profiles"][1]["suggested_instances"] == 4
    assert report["profiles"][2]["suggested_instances"] == 1
    assert all(p["inference_fps"] == 5 and p["input_width"] == 480 for p in report["profiles"])
    assert report["active_analysis"] == 1
    assert report["observed_load"] == 0.14
    assessment.close()


def test_capacity_assessment_does_not_start_duplicate_worker():
    entered, release = threading.Event(), threading.Event()

    def benchmark():
        entered.set()
        release.wait(1)
        return [{"name": "MOG2", "cost_ms": 1}]

    assessment = CapacityAssessment(
        Manager(), hardware_provider=lambda: {"logical_cpus": 4, "memory_bytes": 8 << 30},
        benchmark=benchmark,
    )
    assessment.start()
    assert entered.wait(1)
    worker = assessment._thread
    assert assessment.start()["state"] == "running"
    assert assessment._thread is worker
    started = time.monotonic()
    assessment.close(timeout=0.02)
    assert time.monotonic() - started < 0.2
    release.set()
    worker.join(1)
    assert not worker.is_alive()


def test_invalid_benchmark_cost_sets_safe_error_state():
    assessment = CapacityAssessment(
        Manager(),
        hardware_provider=lambda: {"logical_cpus": 2, "memory_bytes": None},
        benchmark=lambda: [{"name": "MOG2", "cost_ms": 0}],
    )
    assessment.start()
    result = wait_for(assessment, "error")
    assert result["report"] is None
    assert result["error"] == "Capacity assessment failed"
    assessment.close()
