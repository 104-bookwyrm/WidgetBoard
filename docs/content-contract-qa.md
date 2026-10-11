# Content contract QA

Answer each with yes or no (add a note if you like). "Rec" is my recommendation. Decisions land in `content-reference-design.md` afterwards.

## Proposed shape (for reference)

```
data/content.json   { version, items: { <id>: ContentItem } }
ContentItem         { id, type, name, tags: [], rev, created, updated, deletedAt: null, data: {...} }
layout.json         { version: 3, widgets: [ Placement ] }
Placement           { id, type, display, x, y, w, h, contentId | null, view: {...} }
```

- Library types: memo, image, showcase, collection, audioplayer.
- Shared stores stay as they are: events (calendar, D-day), checklist, diary.
- Tools keep their state on the placement: clock, timer, stopwatch, nowplaying.
- `view` holds placement-only options.
- Saved layouts store placements, so they carry `contentId`s.

## Storage

1. All Library content in one file, `data/content.json`, rather than one file per item. Rec: yes. It is small (images are asset references), and backup and migration stay simple.
   Answer: yes. 
2. Revision counter per content item, rather than one per file. A stale memo then can't block a save to an unrelated image. Rec: yes.
   Answer: yes. 
3. The shared stores (events, checklist) get one revision per file. Rec: yes. They are edited as whole lists today.
   Answer: yes.
4. Diary keeps one file per date, with the revision check done per date. Rec: yes.
   Answer: yes.

## What counts as content

5. Memo color belongs to the note and follows it everywhere (Sticky Notes behavior). Rec: yes.
   Answer: yes.
6. Display options stay on the placement and are not part of the content. Examples: image fit, slideshow interval and shuffle, collection columns, frameless. Rec: yes.
   Answer: This depends. frameless, or placement can go towards being a part of the layout, and can be part of the content. Defer this.
7. The audio player's playlist is Library content. Volume, shuffle and loop stay on the placement. Rec: yes.
   Answer: yes.
8. A widget's title is the content's name: renaming it renames it in the Library too. An unnamed memo shows its first line. Rec: yes.
   Answer: yes. 
9. Migration duplicates and rejected stale drafts always go to the memo archive, even with "Keep a history of memos" off. That setting would then control only automatic history. Rec: yes. Otherwise both safety nets vanish for anyone with the archive off.
   Answer: yes. 
10. Every content item gets an empty `tags` field now, so search filters and packs need no second migration later. Rec: yes.
    Answer: yes.

## Closing, deleting, reopening

11. Closing a Library-type widget leaves its content in the Library. Nothing goes to Recently deleted. Rec: yes.
    Answer: yes. 
12. Closing a timer or stopwatch discards its state, with the existing undo toast as the only recovery. Rec: yes.
    Answer: no. timer and stopwatch should keep state, especially with stopwatch's time stacked over sessions.
13. The bin's 50-item cap and the shelf's 60-item cap are removed. Rec: yes.
    Answer: yes.
14. The 30-day purge runs at startup. The 30 days lives in config with no UI. Rec: yes.
    Answer: dangerous. let's think of this more. The current version may not need a backlog clear at this state.
15. Image and audio files are deleted only when the last item referencing them is permanently deleted. Rec: yes. This matches today's erase.
    Answer: yes.
16. Content opened from the Library returns to its last position and monitor. If that spot is taken or the monitor is gone, it goes to a free spot on the primary monitor. Rec: yes.
    Answer: yes.
17. Changing a widget's type sends its old content to the Library as if closed, and the type stash is removed. Rec: yes.
    Answer: yes. think of widget type changing as closing a widget and making a new widget in its place.

## Layouts

18. Applying a layout moves content already shown elsewhere into the layout's slot. Under the one-placement rule, the alternative is skipping that slot. Rec: yes.
    Answer: yes. applying layout is a strong behavior - what are we currently doing for monitors and such?
19. "Undo last layout change" stays. It stores placements only, not content. Rec: yes.
    Answer: stays. yes.

## Library (step 3, asked now because it shapes step 1)

20. The Library is its own window, opened from the tray and the board menu, and is not a page inside Settings. Rec: yes. The design separates content from settings.
    Answer: true. 

## Backups

21. Change the two-week backup tier to weekly now, during step 1, instead of waiting for step 6. Rec: yes. It's small, and `backup_policy.rs` is touched anyway.
    Answer: true.
22. Keep only the newest 5 `pre-restore` snapshots. Pre-migration and manual snapshots are never pruned. Rec: yes.
    Answer: true. 

## Follow-up to 12 (closed timers and stopwatches keep state)

Today the bin already keeps a closed timer or stopwatch with its state, so "keep state" matches current behavior. The bin is going away, so the state needs a new home.

12a. Closed timers and stopwatches go to the Library like other content, each recoverable with its state (a named "Study" stopwatch keeps its stacked total). This reverses "tools never appear in the Library" for these two; the clock stays a tool. Rec: yes. It's the only option that loses nothing when two are closed.
     Answer: yes. Think of timers and stopwatch having one true state per name. 
12b. Only if 12a is no: remember the last closed state per type, and the next new timer or stopwatch continues from it (Windows Clock has one stopwatch). Closing a second one replaces the first's saved state.
     Answer: 12a yes - no answer here.

## Decided by me unless you object

- The schema version lives in `layout.json` (`version` 2 becomes 3) and in `content.json`. Migration runs in Rust at startup before any board loads.
- Saves send `{id, rev}`. Rust compares and writes under one lock and broadcasts `content-changed` to every window.
- `content.json` joins the backup set, and the pre-migration snapshot uses the existing backup code. 
- While a backup restore is running, all writes become no-ops (deferred red-team item 2). - no ops, but the no-ops should be visible to the user so that their content is visibly not written. 
