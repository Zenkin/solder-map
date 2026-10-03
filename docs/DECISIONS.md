# SolderMap decisions

This document describes the supported application and current architectural decisions.

## Repository workflow

`main` is stable. Work uses a semantic branch and a pull request for one scoped task, with validation before review. Squash merge and removal of temporary branches are preferred. See `AGENTS.md` and `.github/CODEX_WORKFLOW.md`.

## Local Electron application

The renderer owns UI state, editing, solder marks, filtering, history and viewport interaction. Pure assembly functions live in `js/assembly.js`; filesystem transfer helpers live in `js/file-operations.js`.

`main.js` owns the filesystem and Electron lifecycle. `preload.js` exposes only named operations through allowlisted IPC. Keep `contextIsolation:true` and `nodeIntegration:false`. Window navigation and additional windows are blocked.

## Project schema and compatibility

Version 4 contains only the supported assembly data: name, images, imageSizes, components, stages, groups and doneMap. Images use `{file}` entries, component rectangles use source-image pixels, and solder marks use `SIDE:REF` keys.

Loading accepts older versions and string image entries. A whitelist preserves component descriptions, rectangle coordinates, unplaced flags, stages, groups and solder marks, without retaining unsupported fields. Opening writes the normalized schema. This migration follows the user's explicit request to remove discontinued functionality completely.

Duplicate references on one side receive a suffix to avoid overwriting another component's geometry or progress. References on opposite sides remain independent.

## Assembly interaction

TOP and BOTTOM always have separate component lists and batches. Batches group by component reference prefix and normalized nominal; resistor and capacitor units and common embedded resistor notation are canonicalized. Generic component values use a case-insensitive normalized string.

The default batch sort uses remaining unsoldered quantity in descending order; total quantity and nominal name are alternate sorts. The context command for a nominal clears other filters and remains on the current side.

Unit-bearing search queries compare electrical nominals exactly before applying any additional text constraints. Explicit resistor/capacitor units are also extracted from compound descriptions containing power, package and tolerance; these metadata numbers cannot substitute for the electrical nominal. Canonical batch keys use the extracted nominal, while stored descriptions and their visible details are preserved. Ambiguous descriptions containing several different electrical values are not guessed.

Pending components are blue; soldered components are green. Selection and batch emphasis use neutral outlines. Stages and groups are filters and metadata, with no color system. Solder marks use explicit reversible commands, with confirmation for a whole batch.

The project-level reset command clears all solder marks on TOP and BOTTOM regardless of active filters, after confirmation. It uses the existing undo/redo and save path, and resets the solder-status filter to show the now-pending components.

## Viewport and editor

Rectangle coordinates remain in image pixels. Zoom changes only the display transform and scrollable canvas size, with cursor anchoring and limits of 5–800%. Space-drag and the middle mouse button pan. Drawing, movement and resize convert pointer positions back into source pixels.

Replacing an image scales existing rectangles proportionally to the new dimensions. Editing and soldering both participate in undo/redo.

## Files and saves

Default storage remains `Documents/SolderMap Projects`; externally opened folders and an optional `SOLDERMAP_PROJECTS_ROOT` are supported.

The main process grants project access after discovery or explicit browsing. File mutations are limited to entries and directories previously listed in the built-in browser. Names reject path traversal and Windows reserved names. Folder transfers reject the source itself and its descendants. Symlink operations are delegated to the system file manager.

Copies and moves choose unused destination names and preserve existing files. Cross-device moves copy successfully before deleting the original. Deletion uses the OS recycle bin after UI confirmation. File operations must not invalidate the active project location.

Writes are queued per project, written to a unique temporary file and atomically renamed. The renderer waits for pending saves before switching projects or closing; write failure keeps the window open and shows an error.

## Distribution

Electron Builder produces NSIS and portable Windows executables, macOS dmg/zip and Linux tar.gz. Icons live in `assets/`. Generated packages, dependencies and personal project data stay out of Git; distributions belong in GitHub Releases.
