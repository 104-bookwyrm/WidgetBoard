# Step 5 QA: settings organization and visible calendar controls

Answer each with yes or no (add a note if you like). "Rec" is my recommendation. Decisions land in `content-reference-design.md` afterwards.

## Today

Settings has 7 pages: General (language, start with Windows, week start, time zone), Appearance (theme, board), Widgets & layout (widget list with rename/hide/move/close, built-in presets, saved layouts, an Open Library button, memo archive), Timer & calendar (alarm, timer quick-start buttons, holidays), Accessibility, Backup & data, About.

The calendar's hidden features: repeat exists only as typed `@yearly` / `@weekly`; tags only as typed `#tag`; time as typed `14:00` or in Details. Details has time, link, time zone and reminder, but no date, repeat or tags. A repeating entry shows a repeat icon instead of a checkbox, so it can't be completed at all.

## Settings: preferences only

1. Settings keeps only preferences. Content and arrangement (widget list, layouts) leave it. Rec: yes. This is the design's direction.
   Answer: yes.
2. The widget list (rename, hide, move to monitor, close) leaves Settings. The board's right-click menu already has hide, close and move; renaming lives in the Library. Rec: yes.
   Answer: yes.
3. Layouts (built-in presets, saved layouts, undo) move into the Library window as a second tab: "Items | Layouts". Tray "Layouts…" opens that tab. Rec: yes. Both are things you made and come back to; Rainmeter's manager keeps skins and layouts side by side the same way.
   Answer: yes.
4. If 3 is no: layouts get their own small window instead.
   Answer: 
5. "Timer & calendar" becomes "Widgets": per-type preferences in one page (timer alarm and quick-start buttons, calendar holidays, week start, memo archive on/off). Week start moves there from General. Rec: yes.
   Answer: yes. 
6. The memo archive's version list moves to the Library: a memo card gets "History", which lists its saved versions. The on/off switch stays in Settings (5). Rec: yes. Versions are content.
   Answer: yes.
7. Resulting pages: General, Appearance, Widgets, Accessibility, Backup & data, About (6). Rec: yes.
   Answer: yes.

## Calendar: what exists gets a visible control

8. Details gets a Date field, so an entry can move to another day. Rec: yes.
   Answer: yes.
9. Details gets a Repeat menu. Rec: yes.
   Answer: yes.
10. Repeat offers only what exists today: none, weekly, yearly. Rec: no, see 11. 
    Answer: no. 
11. Repeat also offers daily and monthly, matching the checklist and Microsoft To Do. Monthly on the 29th-31st falls on the month's last day when the month is shorter (To Do behavior). The reminder engine shares the same rule. Rec: yes.
    Answer: yes. 
12. Details gets a Tags field (type a tag, Enter adds it, x removes it), next to the typed `#tag` shortcut. Rec: yes.
    Answer: yes.
13. The typed shortcuts keep working (`14:00`, `#tag`, `@weekly`), and the add box's placeholder keeps showing an example. Korean shortcuts `@매일` `@매주` `@매월` `@매년` are added. Rec: yes.
    Answer: yes. 

## Repeating entries: single occurrences (open decision 1)

14. A repeating entry gets a checkbox per occurrence: ticking this week's does not tick next week's (the checklist already works this way). Rec: yes. Today a repeating entry can't be completed at all.
    Answer: yes.
15. Skip one occurrence ("not this week") is added now. Rec: no; defer until real use asks for it.
    Answer: no. let it be just a tick to consider as done for now. defer.
16. Change one occurrence only (different time this week) and "this and following" edits stay out of scope. Rec: yes (keep out). They are the large part of recurrence work in every calendar app.
    Answer: yes.

## Decided by me unless you object

- Repeat and done-per-occurrence use the same `occursOn` rule as reminders and the checklist, so all three agree on which days an entry falls.
- Per-occurrence completion is stored on the entry as the list of completed dates, the checklist's `doneKeys` pattern. Old entries need no migration.
- The Library's tab and History follow the existing card style; no new visual language.
