# Portfolio and presentation assets

[Documentation home](README.md)

## Project metadata

The root [portfolio-showcase.json](../portfolio-showcase.json) describes SpyDER’s
features and engineering decisions for the companion portfolio. Asset paths are relative
to the repository root. The portfolio uses its standard section order and opens with an [18-second looping preview](assets/spyder-demo.webp) of all three demonstrations. The individual recordings below are also available as silent MP4s.

## Recorded demonstrations

| Demonstration | Animated preview | Video | What it shows |
| --- | --- | --- | --- |
| Control Room | [WebP](assets/control-room.webp) | [MP4](assets/control-room.mp4) | Three bundled home-security feeds with real local motion boxes and a porch track. |
| Vision Lab | [WebP](assets/vision-lab.webp) | [MP4](assets/vision-lab.mp4) | Installed Python app: source and MOG2 mask side by side, ROI, contours and tracking controls. |
| Visual workflow | [WebP](assets/workflows.webp) | [MP4](assets/workflows.mp4) | Existing enabled porch Approach workflow and its motion node settings in the browser showcase. |

The clips are six seconds at 6 FPS, silent H.264 MP4 and looping WebP. PNG posters
are also provided. They show the application processing bundled footage; they contain
no generated camera patterns, invented detection results or private camera streams.
The motion overlays are not proof of person recognition or detection accuracy.

The native Vision Lab mask editor is an installed-app feature; its recording is not a
claim that it runs in the Cloudflare demo. The recorded browser workflow uses only the
supported browser motion and action nodes. Full model inference needs the appropriate
local runtime and models.

See [asset credits](assets/README.md) for CC BY 3.0 source footage, transformations,
and reuse requirements. Keep attribution with redistributed clips or presentations.
[Media inventory](assets/showcase-media.json) records file sizes, durations and sources.

For setup and capabilities, link to the [project overview](../README.md) and
[documentation index](README.md).
