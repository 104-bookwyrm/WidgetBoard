# Persistent content and board usability

User decisions recorded 2026-10-11. This is an agreed-scope record with explicit open decisions, not a claim of implemented behavior.

## Accepted direction

- Every content-bearing widget refers to persistent content independent of its placement.
- Preserve existing widget IDs, content, appearance, monitor assignments and geometry during migration.
- Closing a placement keeps its content available. Windows Sticky Notes is the reference for this behavior.
- Recovery is essential. Internal bins, shelves and type stashes must not become separate user concepts.
- Nothing destructive happens that the user can't easily see or block. No silent caps drop closed content.
- One placement per Library item (memo, image, showcase, timer, stopwatch...). Opening one already on the board brings it to the front (Sticky Notes behavior). Calendar, checklist and diary placements are views of their shared stores.
- Clock and now-playing are tools, not content: their state belongs to the placement and they never appear in the Library. Timers and stopwatches are Library items: each name has one true state, a stopwatch's total stacks across sessions, and closing one keeps its state in the Library.
- Changing a widget's type is closing it and adding a new widget in its place. The old content stays in the Library; the type stash goes away.
- Preset slots have persistent bindings. Showcase and image placement must preserve the user's chosen content and arrangement.
- JSON writes use revision checks to prevent stale writers replacing newer content.
- The board menu offers a simple baseline with ample decoration and customization.
- Reorganize settings around preferences; separate content management from settings.
- Search starts with a local scan over diary, memo and calendar content. Korean substring matching is required.
- Expose current calendar features through visible controls.
- Due dates and recurrence are separate fields. Recurrence repeats from the due date; turning on repeat without a due date sets it to today (Microsoft To Do behavior). Occurrence-exception scope remains open.
- Automatic backups default on: seven daily snapshots plus one weekly snapshot and one monthly snapshot. The latter two refresh on their own schedules.

## Migration meaning

Migration converts existing saved data when opening the new version. It is not a user-visible reset or a choice to convert only some widgets.

Existing placement IDs remain. Content gets its own stable identity where one is missing. Existing task/event IDs and diary date keys remain usable. Placements store content references; layouts store placements and bindings rather than authoritative copies of content.

Memo text, image lists, showcase profiles and collection/playlist content currently embedded in settings must be extracted. Existing shared checklist/calendar/diary data must remain shared unless the user chooses a future collection feature. Timer and stopwatch state becomes Library content.

Read current state during conversion: active widgets, type stashes, saved layouts, shelf, bin and the memo archive. Layout undo is not converted; the pre-migration snapshot keeps it. Use known identity to group copies. Do not merge separate notes merely because their text matches. Keep the newest copy as current and the rest as memo-archive entries.

Saved data carries a schema version integer. Migration runs when the stored version is older than the app's and bumps it only after activation. No downgrades or rollbacks are planned. Blocking older installs from writing newer data is deferred: a user may prefer an older version.

Take a pre-migration snapshot. Stage and validate the converted data before activation. Make restart after interruption safe. Leave the original snapshot intact. The migration must preserve referenced assets and be idempotent.

## Content contract (QA answered 2026-10-11, see content-contract-qa.md)

```
data/content.json   { version, items: { <id>: ContentItem } }
ContentItem         { id, type, name, tags: [], rev, created, updated, deletedAt: null, data: {...}, placement? }
layout.json         { version: 3, widgets: [ Placement ] }
Placement           { id, type, display, x, y, w, h, name?, settings: {...} }
```

- Library types: memo, image, showcase, collection, audioplayer, timer, stopwatch. Shared stores (events, checklist, diary) stay as they are.
- Revision per content item; one revision per file for events and checklist; per date for diary. Rust compares and writes under one lock and broadcasts `content-changed`.
- Content fields: memo text and color, image list, showcase profile, collection items, audio playlist. Audio volume, shuffle and loop stay on the placement. Other display options (fit, interval, columns, frameless) stay where they are for now; whether they belong to content or layout is deferred.
- The widget title is the content's name. An unnamed memo shows its first line.
- Migration duplicates and rejected stale drafts always go to the memo archive, even with automatic memo history off.
- Every item has a `tags` field from the start.
- The Library is its own window, opened from the tray and the board menu.
- A Library placement's id is its content id (one placement per item), so there is no separate `contentId`. Migration keeps existing widget ids; a stashed type, or an older copy of an id that has since changed type, becomes `<id>-<type>`.
- Placement-only options keep the field name `settings` (13 widgets read it). Which settings keys are content is listed once in `ui/widgets/content-keys.json`, read by the board and compiled into the Rust migration. The board merges content into `settings` for widgets and splits it on save.
- `placement` on a content item is where it was when it left the board, for reopening. The placement's `name` is a display copy for the settings window; the item's `name` is the real one.
- No release before the Library window (step 3) ships: between migration and step 3, closed content is safe in content.json but has no recovery UI.
- The schema version lives in `layout.json` (2 to 3) and `content.json`. Migration runs in Rust at startup before any board loads. `content.json` joins the backup set.

## Persistence and recovery requirements

- Revision comparison and the write occur under the same backend synchronization boundary.
- Every saved change is pushed live to every view of the same content (board placement, Library, settings window), so stale edits are rare. The revision check is a silent safety net: a rejected stale save never overwrites the newer edit. A rejected memo draft goes to the memo archive.
- Data updates do not overwrite placement geometry; geometry changes do not overwrite data.
- Library exposes content whether displayed or absent from the board.
- Deletion is explicit. "Delete" moves content to a Recently deleted view in the Library. There is no automatic purge: data is small, so items stay until the user deletes them permanently. "Delete permanently" is the only irreversible action and asks first. Closing a widget is not content deletion.
- Image and audio files are deleted only when the last item referencing them is permanently deleted.
- Content reopened from the Library returns to its last position and monitor; if the spot is taken or the monitor is gone, it goes to a free spot on the primary monitor.
- Applying a saved layout (all monitors) moves content shown elsewhere into the layout's slot. Built-in presets (this monitor) never take content already on the board.
- "Undo last layout change" stays and stores placements only.
- While a backup restore runs, writes are no-ops and every window says so: an overlay ("Restoring a backup. Changes are not saved; WidgetBoard will restart.") blocks input until the restart.
- Keep the newest 5 pre-restore snapshots. Pre-migration and manual snapshots are never pruned.
- Layout restore resolves current content by reference. A placement whose content was deleted is skipped; a widget type that works without content restores empty instead. A backup restore is the distinct operation that restores an earlier data state.
- Preset bindings use stable slot IDs. A built-in preset slot fills in this order: the content last shown in that slot in that layout, else the most recently used content of that type not already on the board, else new empty content.
- Daily pruning does not remove weekly/monthly snapshots, manual snapshots or pre-migration snapshots.
- Replace a scheduled backup only after its successor is verified complete.
- A stopped app cannot create past snapshots; perform a due backup after startup without inventing historical dates.
- Search normalizes Unicode consistently for matching and keeps original text for display. Test Korean substrings and composed/decomposed Hangul.

## UI copy (ships with the Library, step 3)

- `lay.help` en: "Arranges all your widgets at once. Your notes and photos stay in your Library, so switching never loses them. You can always undo."
- `lay.help` ko: "위젯 배치를 한 번에 바꿉니다. 메모와 사진은 보관함에 남아 있어 배치를 바꿔도 사라지지 않습니다. 언제든 되돌릴 수 있습니다."
- Library 보관함 · Recently deleted 최근 삭제된 항목 · Delete 삭제 · Delete permanently 영구 삭제.

## Open decisions to surface

- Whether display options (frameless, fit, columns) belong to content or layout.

1. Occurrence exceptions now: support changing/skipping/completing one occurrence, or defer while exposing existing recurrence controls? Editing this-and-future occurrences is a larger separate scope.
2. Calendar-month backup cadence versus a fixed 30-day interval. Proposed interpretation: calendar month.
3. Existing explicit backup opt-outs: preserve them on upgrade unless the user requests an override.
4. Independent named checklist/calendar collections were not requested; preserve the present shared collections.

## Implementation sequence

1. Content contracts, revision-safe persistence and migration/recovery tests.
2. Convert content-bearing widgets and layouts; verify restart, multi-monitor state, asset retention and interrupted migration.
3. Library recovery and persistent preset bindings.
4. Korean-first local search and board-menu entry points.
5. Settings organization and visible calendar controls.
6. Scheduled backup tiers and restore validation.
7. Regression suite and native desktop checks. Keep all generated artifacts in root test-artifacts/.

## Later phase: layout export/import and packs

Starts only after the Library and stable shared data (steps 1-6). A pack is a layout export that also carries content, so build layout export/import first and extend it.

1. **Pack file.** One file holds layout, theme, per-placement content and images. Import copies content into the Library as new items and binds the layout's slots to them. Distribution happens outside the app (Discord, X, booth); we host nothing.
2. **Pack tag.** Calendar events and D-days from a pack enter the shared stores tagged with the pack and can be removed as one group (depends on the deferred bulk clear by tag). Pack events carry their timezone.

Rules:
- **Export by tag.** An export includes only content sharing the chosen tag. Content with the hide tag is excluded from every export, whatever its other tags. Requires tags on all content types; today only calendar and D-day events have them.
- **Reimport adds only new items.** Items already imported from the same pack are skipped by pack item ID. Reimport never replaces or removes anything. Real pack updates are out of scope.
- **Data only.** No scripts and nothing that can run code. The pack is a single JSON file with images embedded, so import never unzips (avoids path-traversal and zip-bomb handling). Images are limited to PNG, JPEG, WebP and GIF; no SVG, since it can carry script. CSS follows the existing rule: remote addresses are ignored. Unknown fields are dropped. The size cap lives in config.
- **Copyright disclaimer** on export, import and the README: users share what they choose and are responsible for it. WidgetBoard hosts and distributes nothing.

Calendar subscription (.ics URL) is a good fit for living schedules but stays an idea: creators and fans don't share one calendar source.

Preserve the existing dirty checkout. Reuse the single browser mock. No commits or release operations are implied by this record.
