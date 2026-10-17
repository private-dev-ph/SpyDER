# Troubleshooting

[Documentation home](README.md)

## Changes do not appear

In an editable installation, save HTML/CSS/JavaScript and refresh; use Ctrl+Shift+R
if needed. Restart Python after Python changes. A wheel is a snapshot: rebuild and
reinstall it, or switch to editable mode. Confirm the import source:

```powershell
.\.venv\Scripts\python.exe -c "import spyder_cctv; print(spyder_cctv.__file__)"
```

An exported showcase is another snapshot. Re-export to a fresh directory; source
edits do not update a previous export. See the [development guide](development/guide.md).

## Connection reset or port in use

Read the launching terminal for the actual error. Replacing package files while an
older server runs can break asset requests. Finish recording, press Ctrl+C in that
server's terminal, then start one fresh instance. Closing its browser tab is insufficient.

On Windows, inspect the listener:

```powershell
Get-NetTCPConnection -LocalPort 8765 -State Listen |
    Select-Object LocalAddress, LocalPort, OwningProcess
```

Verify the process command line before terminating it. Avoid stopping all Python
processes. Use the printed `127.0.0.1` URL; a different host name may fail the local
Host guard. A different port is useful for isolated testing, but cannot solve two
processes competing for the same camera or recording folder.

## Camera is unavailable or blank

Test one camera with analysis disabled. Check its source, device permissions, and
whether another app holds it. Local file codecs and network stream support depend
on OpenCV. The hosted showcase accepts browser webcams and selected local videos,
not RTSP or arbitrary filesystem paths. Browser webcam access requires HTTPS or a
trusted localhost context and permission after a user action.

## Workflow will not enable or no events arrive

Start the bound camera separately. Confirm Camera and Model connections, installed
engine dependencies, available weights, and filter source. Save and enable are
separate actions. Review activation errors and consent prompts. A model class is
not automatically a recognized identity. Paused cameras, stale inference, unmatched
filters, cooldowns, or a missing Event node can explain an empty Events list.
See [Vision Lab and workflows](user-guide/vision-workflows.md).

## Recordings stopped or recovery is pending

Check System's storage allowance and physical free space. Stop-and-save or cleanup
policies may block future starts until space is resolved; freeing space does not
automatically resume a session. Keep-forever clips cannot be reclaimed automatically.
After a crash, restart once the old encoder has exited. Preserve partial files,
journals, and interruption tails if recovery reports a problem. Do not rename or
remove these files while a recorder is active. See [recording recovery](recording-storage.md#unexpected-stops-and-recovery).

## Report a problem

Include the launch command, package version, operating system, browser, reproduction
steps, and exact terminal/console error. State whether the issue affects the installed
app or static showcase. Use synthetic inputs where possible; redact stream credentials,
private paths, identities, and footage before sharing diagnostics.
