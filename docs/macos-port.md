# macOS port direction

This branch is a Mac product adaptation, not a literal Windows UI port. Shared widget, layout,
theme and persistence code stays cross-platform; operating-system behavior belongs behind small
platform boundaries in the Tauri core.

## Existing Mac products

| Product | What it already covers | Space left for WidgetBoard |
| --- | --- | --- |
| [macOS desktop widgets](https://support.apple.com/guide/mac-help/add-and-customize-widgets-mchl52be5da5/mac) | System gallery, standard sizes, interactive controls, wallpaper dimming, iPhone widgets | Rich editing, arbitrary layouts, shared local data, backups, theming and focused workspaces |
| [WidgetWall](https://apps.apple.com/us/mac/app/widgetwall/id1618466427) | Large gallery of decorative and utility widgets, photos, media, notes, timers and customization | Local-first data portability, coherent planning tools, layout history and open theme files |
| [DeskWidgets](https://byteapps.studio/deskwidgets) | Notes, tasks, calendar, reminders, timers, launchers and system information | Multi-monitor boards, restore-safe persistence, accessibility and Korean-first workflows |
| [Übersicht](https://tracesof.net/uebersicht/) | Highly customizable HTML/JS widgets and command output on the desktop | A safe, finished experience that does not require users to write or audit code |

WidgetBoard should lead with a private, durable desktop workspace: editable widgets that share
data, named layouts, backups, per-monitor placement and human-readable local files. A generic
"more widgets" pitch would be undifferentiated on current macOS.

## Mac interaction rules

- Run as a menu-bar utility, without a permanent Dock icon.
- A primary click opens the menu. Explicit Show, Edit and keyboard-mode actions may lift boards;
  otherwise boards sit above the wallpaper and below application windows.
- Boards join all Spaces. Pinned widgets remain intentionally floating.
- Use Command for application shortcuts, Option for precision movement and Control-click for
  contextual actions. Preserve Ctrl equivalents on Windows.
- Use “Open at Login”, system notifications, Finder, Application Support and the Documents folder
  in product copy.
- Respect Reduce Motion and macOS appearance. A future dimming option should follow the system's
  full-colour/monochrome desktop-widget convention without copying WidgetKit's visual design.
- Never modify the signed executable inside an app bundle. Updates ship as signed app archives
  through Tauri's updater and distribution builds are signed and notarized.

## Delivery order

1. Buildable `.app` and `.dmg`, Mac icon, file/URL opening, local timestamps and menu-bar lifecycle.
2. Desktop-level/all-Spaces boards, click-through behavior, Retina and multi-monitor validation.
3. Login Item, notifications, Command shortcuts, Mac copy and system font discovery.
4. Signed updater artifacts, universal builds, code signing and notarization.
5. Decide whether system Now Playing can use a stable public API; local audio remains available
   even if system-wide media control stays disabled.

