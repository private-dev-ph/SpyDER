# Public documentation

- [Project overview, capabilities and setup](../README.md)
- [Contribution guidelines](../CONTRIBUTING.md)
- [Portfolio showcase metadata](../portfolio-showcase.json)

## Presentation assets

| Asset | What it shows |
| --- | --- |
| [Control Room](assets/control-room.png) | The static browser showcase with two locally generated camera feeds. |
| [Vision Lab](assets/vision-lab.png) | The native workflow editor with synthetic camera input and demonstration detections. |
| [Project emblem](../src/spyder_cctv/assets/spyder-emblem.png) | The shared SpyDER application and portfolio logo. |

These are captures of the running interface, not production surveillance footage or
model-accuracy evidence. No private cameras, faces, recordings or uploaded weights are
included. Screenshots are stored as PNG files; the application uses its shared SVG icon sprite.

## Portfolio integration

The repository-root `portfolio-showcase.json` describes the problem, purpose, features,
technology, role, implementation decisions, challenges, results and lessons. Image paths
are relative to the repository root and include accessible alternative text and captions.
The existing emblem is reused rather than introducing a second project identity.

`internalDemoAvailable` remains `false` until a public deployment is ready. No undeployed
URL or unverified mapping to an existing portfolio project is included. Publishing this
metadata and the assets to the repository's default branch is a separate step from local
preparation; this change does not deploy the application or refresh the portfolio cache.

Engineering notes remain in the local, Git-ignored `docs/` directory. Public pages must
not depend on that directory, and source distributions exclude it.
