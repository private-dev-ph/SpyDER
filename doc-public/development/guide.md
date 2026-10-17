# Development guide

[Documentation home](../README.md)

## Environment and edit cycle

Use the [getting-started installation](../getting-started.md) and reuse one `.venv`
for development, tests, and packaging. The app has no frontend compilation step and
no automatic Python reload. Keep one local server per port, and stop active recordings
before restarting or reinstalling a package.

| Change | Required action in editable mode |
| --- | --- |
| HTML, CSS, JavaScript, SVG, images | Save and refresh; hard-refresh for stale cached assets. |
| Python implementation | Stop the server with Ctrl+C and restart. |
| Dependencies/build metadata | Stop, reinstall editable dependencies, restart. |
| Tests | Run the relevant checks. |
| Static showcase source | Export a new output directory and preview that export. |

A wheel installation and a showcase export are snapshots. Source edits do not update
them automatically. Check which source tree is active:

```powershell
.\.venv\Scripts\python.exe -c "import spyder_cctv; print(spyder_cctv.__file__)"
```

Editable mode should resolve to the checkout's `src/spyder_cctv`. To restore it without
changing dependencies:

```powershell
.\.venv\Scripts\python.exe -m pip install --no-deps --no-build-isolation -e .
```

Omit `--no-deps` when dependencies changed. Do not replace package files beneath a
running server: stale processes can fail requests after installation.

## Isolate development data

```powershell
.\.venv\Scripts\python.exe -m spyder_cctv --config .\.pytest_cache\dev-app\config.json gui
```

The separate config parent holds test workflows, events, models, and default media.
Do not point a trial at an everyday recording folder. Prefer injected captures or
fixture videos in tests. Two configurations do not isolate a physical camera, and
multiple application instances should not share an output folder.

## Automated checks

Run focused tests while editing, then the standard checks before integration:

```powershell
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m ruff format --check .
.\.venv\Scripts\python.exe -m pytest -q
node --test
```

Node.js 22+ is used for JavaScript tests, not as the application runtime. No npm
installation is needed for those tests. Examples of focused checks:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_recording_recovery.py tests/test_showcase.py
node --test tests/browser-recording.test.cjs tests/showcase-runtime.test.cjs
```

Tests use temporary storage and synthetic/injected inputs. A passing synthetic test
does not establish real model accuracy, supported camera count, or recovery from
physical disk failure. For UI work, also check desktop, narrow and short-height windows,
both themes, keyboard focus, console/network errors, and reduced-motion behavior.

Browser regression scripts can use a fresh exported showcase with an isolated Chrome
profile. For example, `node tests/layouts-browser.mjs <export-directory>` checks layouts;
`node tests/camera-priority-browser.mjs <export-directory>` exercises large synthetic
walls. Set `CHROME_PATH` if Chrome is installed outside the script's default location.
See [Layouts](../layouts.md#development-checks) for the distinction between layout
stress tests and physical-camera capacity.

## Build and verify an installation

Build into a new release output directory using the existing environment:

```powershell
.\.venv\Scripts\python.exe -m build --no-isolation --outdir .\dist\release-check
```

Stop SpyDER before switching installation modes. Install the exact wheel just built:

```powershell
$spyderPython = (Resolve-Path .\.venv\Scripts\python.exe).Path
$releaseWheel = Get-ChildItem .\dist\release-check -Filter *.whl |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $releaseWheel) { throw "Build did not produce a wheel" }
& $spyderPython -m pip install --no-deps --force-reinstall $releaseWheel.FullName
Push-Location $env:TEMP
try {
    & $spyderPython -m spyder_cctv --version
    & $spyderPython -c "from importlib.resources import files; assert files('spyder_cctv').joinpath('assets/dashboard.html').is_file()"
    & $spyderPython -m pip check
} finally {
    Pop-Location
}
```

Remove any custom source `PYTHONPATH` from that check. Test the installed GUI outside
the checkout using separate data, then stop it and restore editable mode from the
repository root. No second virtual environment is necessary. CI exercises Python
3.11/3.13 on Windows/Linux and repeats tests against an installed wheel.

Package assets belong in declared package data and are read through
`importlib.resources`. Public Markdown and presentation PNGs are included in the
source distribution; local `docs/` notes are excluded. Documentation edits do not
require restarting the app. Publishing a package requires a distribution-license
decision; no project distribution license has been selected yet.

Next: [Architecture](architecture.md), [Cloudflare showcase](../deployment/cloudflare.md),
and [Contributing](../../CONTRIBUTING.md).
