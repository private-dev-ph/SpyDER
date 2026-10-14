# Contributing

Use the development setup in README.md. Keep the package under `src/` and tests under `tests/`.
Use type annotations for public interfaces and descriptive names. Inject device and pipeline
dependencies into the manager instead of requiring physical hardware in unit tests.

Before committing, run `python -m ruff check .`, `python -m ruff format --check .`,
`python -m pytest`, and `python -m build` using the development environment. Install the wheel
in the same `.venv` and run the CLI and tests outside the repository. This catches missing
package data and accidental checkout-relative paths. Uninstall the editable package before wheel
installation, then reinstall `-e ".[dev]"` to resume development. CI performs the installed check
on Windows and Linux.

For fullscreen ribbon hit testing, export a fresh showcase with
`python -m spyder_cctv export-showcase --output dist/ribbon-check`, then run
`node tests/fullscreen-browser.mjs dist/ribbon-check` (Node 22+ and Chrome required).
Set `CHROME_PATH` when Chrome is installed elsewhere. The check uses an isolated
temporary browser profile and real mouse presses in both themes.

Document externally visible configuration or API changes. Keep camera imports side-effect free.
Do not commit local configuration containing device addresses or credentials. No distribution
license has been chosen yet; choose one before publishing to a public package index.
