# Changelog

All notable changes to SplatCam. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Planned
- Lights added to the scene (point / spot, then surface orientation, then shadows).
- Ease in / ease out / ease in-out presets on timeline keys.
- Several scenes in one shot.

## [0.1.0] - 2026-10-27

First version: milestones M0 to M8 are delivered. M7, M7bis and M8 still need to be checked by eye (real folder picker, real phone).

### Added

**Foundation (M0)**
- Vite + TypeScript project, PlayCanvas 2.23 on WebGPU.
- Scene loading by drag and drop, orbit camera, FPS HUD.

**Real camera (M1)**
- 9 sensor formats, from Super 8 to medium format; focal length, horizontal / vertical / diagonal FOV.
- Scene scale in meters.
- Separate exploration and shooting cameras, frame matched to the sensor's aspect ratio.

**Depth of field (M2)**
- Multi-sample HDR accumulation: averaged linear sub-renders, Halton samples on the pupil.
- Sheared projection that keeps the focal plane fixed; exact thin-lens CoC.
- Aperture from f/1.2 to f/22, focus in meters or by clicking on the scene.
- Progressive preview, from 1 to 1024 samples.

**Bokeh and tilt / shift (M3)**
- Aperture shapes (disc, N blades, rounding, rotation), onion rings, spherical aberration, cat-eye, swirl, anamorphic squeeze.
- Shift through an asymmetric frustum, Scheimpflug tilt / swing.
- JSON lens presets.

**Shot timeline (M4)**
- X / Y / Z, pan / tilt / roll, focus (diopters) and zoom (log) tracks.
- Bézier curve editor (Bézier, linear and hold keys; overshoot-free auto handles).
- Dope sheet, transport (play, scrub, loop), record mode.

**Shutter and defects (M5)**
- Motion blur from the shutter angle: each sample reads the timeline at its own instant.
- Rolling shutter, gate weave.

**Optics and film (M6)**
- Tone mapping (ACES, Reinhard, none), exposure in EV, highlight gain.
- Bloom, halation, vignetting, distortion, chromatic aberration.
- ISO noise, film grain.
- 9 original film stocks, `.cube` LUT looks.
- Flares: diffraction starbursts, anamorphic streaks, ghosts, lens dirt.

**Export (M7, M7bis)**
- Deterministic 16-bit PNG sequence (`shot_00001.png`), to a folder or as a ZIP, with resume, cancel and settings written to `shot_export.json`.
- H.264 / H.265 MP4 preview (WebCodecs + Mediabunny), codecs queried at runtime.
- Finishing `ffmpeg` commands (ProRes 4444, 10-bit H.265) shown at the end of a sequence.

**Comfort (M8)**
- JSON project (save / open, field validation).
- Keyboard shortcuts with built-in help.
- Phone remote (local relay in the Vite server, token, self-signed HTTPS) and mobile layout.

**After M8**
- Redesigned interface: top bar, Camera, Lens, Frame rate, Image, Optics, Monitor and Scene tabs.
- 34 lenses, including 24 real-world series, with optical flaws, focal length range, maximum aperture and minimum focus distance.
- Depth of field and hyperfocal display; numeric camera position.
- Scene placement (position, rotation and scale around the model's center, ⌥ + arrow shortcuts).
- Preview resolution 50% / 100% / Retina.
- On-screen aids: zebras, focus peaking (Sobel on log luminance, color, black-and-white option, `P` key), thirds, safe areas, format masks.
- Color grading: temperature and tint, contrast, saturation, lift / gamma / gain with color.
- "My settings", frame rates from 23.976 to 60 fps, custom colors for halation and streaks.
- QR code to open the phone remote.

### Fixed
- Audit of rendering, export and timeline: HDR target lost after exploring, memory leak on scene change, export stuck on error, unbounded ZIP, key snapping at 25 fps, AZERTY keyboards, project bounds.
- True 16-bit export: sub-render and post-processing source in RGBA32F during export.
- On-demand rendering while exploring, to spare the Apple Silicon GPU.

[Unreleased]: https://github.com/freddewitt/splatcam/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/freddewitt/splatcam/releases/tag/v0.1.0
