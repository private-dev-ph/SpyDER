"""Bounded, read-only health summaries from existing runtime snapshots."""

from datetime import datetime


def summarize_health(cameras, recording, workflows, *, free_bytes=None, schedules=None):
    issues = []

    def add(severity, area, message, camera_id=None):
        if len(issues) < 256:
            issues.append(
                {
                    "severity": severity,
                    "area": area,
                    "message": str(message)[:240],
                    "camera_id": camera_id,
                }
            )

    running = 0
    for camera in cameras[:64]:
        ident = camera.get("id")
        name = camera.get("name") or ident or "Camera"
        state = camera.get("state")
        if state == "error":
            add("error", "camera", f"{name}: {camera.get('error') or 'capture failed'}", ident)
        if state == "running":
            running += 1
            age = camera.get("frame_age_seconds")
            if age is None or (isinstance(age, (int, float)) and age > 3):
                add("warning", "camera", f"{name}: no fresh frame in the last three seconds", ident)
            metadata = camera.get("metadata") or {}
            for key in ("cv", "analysis"):
                result = metadata.get(key) or {}
                if result.get("state") in ("error", "unavailable", "stopping"):
                    add(
                        "error" if result.get("state") == "error" else "warning",
                        "inference",
                        f"{name}: {key} "
                        f"{result.get('error') or result.get('message') or result['state']}",
                        ident,
                    )
                elif (
                    result.get("state") == "ready"
                    and isinstance(result.get("result_age_seconds"), (int, float))
                    and result["result_age_seconds"] > 3
                ):
                    add("warning", "inference", f"{name}: {key} results are stale", ident)
    if recording.get("error"):
        add(
            "error" if recording.get("state") == "error" else "warning",
            "recording",
            recording["error"],
        )
    allowance = recording.get("allowance") or {}
    if allowance.get("blocked"):
        add(
            "error",
            "storage",
            "Recording storage is blocked; resolve the allowance before recording",
        )
    if allowance.get("error"):
        add("error", "storage", allowance["error"])
    if free_bytes is not None and free_bytes < 64 * 1024 * 1024:
        add("error", "storage", "Less than 64 MiB of physical storage remains")
    recovery = recording.get("recovery") or {}
    if recovery.get("pending"):
        add(
            "warning",
            "recovery",
            f"{len(recovery['pending'])} interrupted recording(s) need recovery review",
        )
    if recovery.get("durability_warning"):
        add("warning", "recovery", recovery["durability_warning"])
    if workflows.get("storage_error"):
        add("error", "workflow", workflows["storage_error"])
    if schedules and schedules.get("error"):
        add("warning", "schedule", schedules["error"])
    if schedules:
        for warning in schedules.get("warnings", [])[:8]:
            add("warning", "schedule", warning)
    for ident, entry in (workflows.get("debug") or {}).items():
        for node_id, node in entry.get("nodes", {}).items():
            if entry.get("enabled") and node.get("state") == "error":
                add(
                    "error",
                    "workflow",
                    f"Workflow {ident}, node {node_id}: {node.get('error') or 'execution failed'}",
                )
    severity = (
        "error"
        if any(item["severity"] == "error" for item in issues)
        else "warning"
        if issues
        else "healthy"
    )
    return {
        "state": severity,
        "checked_at": datetime.now().astimezone().isoformat(),
        "running_cameras": running,
        "camera_count": len(cameras),
        "recording_state": recording.get("state", "unknown"),
        "issues": issues,
    }
