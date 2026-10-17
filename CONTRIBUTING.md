# Contributing

Use the [getting-started guide](doc-public/getting-started.md) for setup and the
[development guide](doc-public/development/guide.md) for edit/restart behavior, isolated
testing, and installed-wheel verification.
Public documentation belongs in [doc-public/](doc-public/README.md). Keep engineering
notes and drafts in the local `docs/` directory; it is ignored by Git and excluded
from source distributions. Public pages must not link to local-only documentation.
Keep the package under `src/` and tests under `tests/`.

Use type annotations for public interfaces and descriptive names. Inject device and pipeline
dependencies into the manager instead of requiring physical hardware in unit tests.

Before committing, run Ruff lint/format checks, the Python suite and `node --test`
using the existing development environment. Build and check the installed wheel outside the checkout
for packaging changes. Use the same `.venv` when switching installation modes, stop
SpyDER first, and restore editable mode afterward. CI also checks the installed wheel
on Windows and Linux. Include validation results and relevant platform limitations
with a contribution.

For fullscreen ribbon hit testing, export a fresh showcase with
`python -m spyder_cctv export-showcase --output dist/ribbon-check`, then run
`node tests/fullscreen-browser.mjs dist/ribbon-check` (Node 22+ and Chrome required).
Set `CHROME_PATH` when Chrome is installed elsewhere. The check uses an isolated
temporary browser profile and real mouse presses in both themes.

Document externally visible configuration or API changes. Keep camera imports side-effect free.
Do not commit local configuration containing device addresses or credentials. No distribution
license has been chosen yet; choose one before publishing to a public package index.
