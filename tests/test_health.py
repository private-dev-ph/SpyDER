from spyder_cctv.health import summarize_health


def test_health_is_read_only_and_paused_cameras_are_not_outages():
    cameras = [
        {"id": "paused", "state": "stopped"},
        {"id": "live", "state": "running", "frame_age_seconds": 0.1},
    ]
    health = summarize_health(cameras, {"state": "idle"}, {})
    assert health["state"] == "healthy" and health["running_cameras"] == 1
    assert cameras[0] == {"id": "paused", "state": "stopped"}


def test_combines_stale_frames_inference_storage_and_recovery():
    health = summarize_health(
        [
            {
                "id": "cam",
                "state": "running",
                "frame_age_seconds": 9,
                "metadata": {"cv": {"state": "error", "error": "model unavailable"}},
            }
        ],
        {
            "state": "error",
            "error": "encoder failed",
            "allowance": {"blocked": True},
            "recovery": {"pending": ["partial"]},
        },
        {},
        free_bytes=0,
    )
    assert health["state"] == "error"
    assert {item["area"] for item in health["issues"]} == {
        "camera",
        "inference",
        "storage",
        "recording",
        "recovery",
    }


def test_only_active_workflow_errors_are_health_issues():
    workflows = {
        "debug": {
            "disabled": {"enabled": False, "nodes": {"code": {"state": "error"}}},
            "enabled": {
                "enabled": True,
                "nodes": {"code": {"state": "error", "error": "bad expression"}},
            },
        }
    }
    health = summarize_health([], {"state": "idle"}, workflows)
    assert len(health["issues"]) == 1
    assert "enabled" in health["issues"][0]["message"]


def test_health_limits_issue_count_and_message_size():
    health = summarize_health([{"state": "error", "error": "x" * 1000}] * 10000, {}, {})
    assert len(health["issues"]) <= 256
    assert all(len(issue["message"]) <= 240 for issue in health["issues"])
