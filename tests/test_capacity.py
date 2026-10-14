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


def test_capacity_estimates_measured_whole_stack_and_available_memory():
    manager = Manager(
        [
            {
                "state": "running",
                "analysis_settings": {"enabled": True, "inference_fps": 5},
                "vision_inference_fps": 4,
                "metadata": {
                    "analysis": {"processing_ms": 20, "effective_fps": 2},
                    "cv": {"inference_ms": 10},
                },
            },
            {
                "state": "stopped",
                "analysis_settings": {"enabled": True, "inference_fps": 30},
                "metadata": {"analysis": {"processing_ms": 1000}},
            },
        ]
    )
    assessment = CapacityAssessment(
        manager,
        hardware_provider=lambda: {
            "logical_cpus": 32,
            "memory_bytes": 8 << 30,
            "available_memory_bytes": 256 << 20,
        },
        benchmark=lambda: [
            {"name": "MOG2", "cost_ms": 20},
            {"name": "Motion regions", "cost_ms": 100},
            {"name": "MIL tracking", "cost_ms": 400},
        ],
    )
    assessment.start()
    result = wait_for(assessment, "ready")
    report = result["report"]
    profiles = report["profiles"]

    assert [profile["name"] for profile in profiles] == [
        "MOG2",
        "Motion regions",
        "MIL tracking",
    ]
    assert [profile["cost_ms"] for profile in profiles] == [20, 100, 400]
    assert [profile["suggested_instances"] for profile in profiles] == [2, 1, 0]
    assert all(profile["inference_fps"] == 5 for profile in profiles)
    assert all(profile["input_width"] == 480 for profile in profiles)
    assert report["hardware"] == {
        "logical_cpus": 32,
        "memory_bytes": 8 << 30,
        "available_memory_bytes": 256 << 20,
    }
    assert report["active_analysis"] == 1
    assert report["observed_load"] == 0.08
    assert "not CPU percentages" in report["message"]
    assert "not predicted" in report["message"]

    profiles[0]["suggested_instances"] = 999
    manager._statuses[0]["state"] = "stopped"
    updated = assessment.snapshot()["report"]
    assert updated["active_analysis"] == 0
    assert updated["observed_load"] is None
    assert updated["profiles"][0]["suggested_instances"] == 2
    assessment.close()


def test_capacity_assessment_does_not_start_duplicate_worker():
    entered, release = threading.Event(), threading.Event()

    def benchmark():
        entered.set()
        release.wait(1)
        return [{"name": "MOG2", "cost_ms": 1}]

    assessment = CapacityAssessment(
        Manager(),
        hardware_provider=lambda: {"logical_cpus": 4, "memory_bytes": 8 << 30},
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
