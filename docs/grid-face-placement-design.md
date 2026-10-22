# Face-based grid placement

Status: nearest-face laboratory behavior approved for testing. No application changes are approved by this document.

## Intent

Dragging a widget against a particular face of another widget should express where the dragged widget belongs and which way the other widget should move. An empty destination should remain empty of side effects. Collision chains remain valid when a push reaches other widgets.

The face is a local interaction with the target. The starting location of the dragged widget does not select the push direction. The laboratory measures cursor distance to every finite target face. Occupied space therefore has no face-recognition dead zone.

## Approved laboratory algorithm

The laboratory treats widgets as solid items inside a bounded box. A dragged widget claims its snapped candidate. An empty candidate produces a free placement without side effects. An occupied candidate produces insertion intent and makes the contacted item create room.

1. Find existing rectangles that overlap the mover's snapped candidate. Unrelated rectangles do not participate in face recognition.
2. Measure grid-space distance from the cursor to each finite face segment of every contacted rectangle. Rank target-face pairs by shortest distance. Use overlap area and target geometry as stable target tie-breaks.
3. Retain the prior target and face while its distance remains within `0.15` cells of the nearest candidate. The prior face must still produce a valid displacement when a tied alternative can succeed.
4. Treat faces within `0.05` cells as a geometric tie. Evaluate the tied directions with a cap of four. Prefer viable directions over locked directions. Use an explicit clockwise `top`, `right`, `bottom`, `left` priority when several tied directions share the same viability.
5. Map the selected face to one movement vector. Top pushes down. Right pushes left. Bottom pushes up. Left pushes right.
6. Place the mover at the candidate. Push each actual collider far enough to clear its source. Continue through the collision closure using the same vector.
7. Keep the operation atomic. A boundary or hidden/fixed reservation can produce a locked result. Locked results preserve the starting layout. Their trace marks attempted movement as provisional.
8. Bound consideration to mover collisions, four tied face candidates and the chosen direction's collision closure. A crowded connected chain may still move every contacted rectangle. Sparse layouts inspect and move fewer rectangles.
9. Preview the selected face, reason, displacement facts and locked cause before adoption. Broad reorganization is reviewable evidence rather than an automatic failure.

The laboratory runs curated human-expectation cases and a bounded `3 × 3` matrix. The matrix checks every cell against all four faces. Placement invariants check bounds, overlap, size preservation, movement direction, collision provenance and atomic locking.

## Coordinate examples

These examples use a 10 × 10 board. `(1,1)` is the bottom left. WidgetBoard's stored grid coordinates instead start at the top left and use zero-based indices.

- A is 1 × 1 at `(1,10)`.
- B is 2 × 2 at `(2,9)` through `(3,10)`.
- C is 1 × 1 and starts at `(10,10)`.
- D is 1 × 1 at `(5,10)`.

| Interaction | Intended result |
| --- | --- |
| C targets B's top face | B moves down. C occupies a valid cell in B's former top row. |
| C targets B's left face | B moves right. C occupies a valid cell in B's former left column. |
| C is placed at empty `(4,10)` | D stays at `(5,10)`. Other widgets stay in place. |
| C targets D's left face for insertion | C occupies `(5,10)`. D moves right to `(6,10)` if that space is available. |
| C targets D's right face for insertion | C occupies `(5,10)`. D moves left to `(4,10)` if that space is available. |

The margin and the face hit area must allow the user to express an insertion even when the next grid cell is empty. A normal drop into that empty cell must remain available. The boundary between those intentions needs testing. A at `(1,10)` also occupies part of the approach to B's left face. The interaction must not assume a free cell exists on that side.

## Current implementation

The shared `resolve(moverId, rect)` function in `ui/app.js` starts with the requested grid rectangle. It finds overlaps and tries four positions for each affected widget. It prefers a destination with no current overlap. It then prefers a shorter displacement. It recursively pushes widgets when needed. The resolver uses a bounded search and returns failure when it cannot resolve the layout within that search.

The grid drag handler rounds pointer movement to cell increments. It clamps the candidate rectangle to the board. It recomputes the layout only when that rectangle changes. It previews the result from the saved widget positions. It commits a valid layout on drop. An invalid drop returns to the saved layout. Click-to-carry uses the same grid drag path.

The resolver does not receive the pointer location or a target face. A movement within one snapped cell cannot change the selected push. A clear destination can win even when it is on a different face from the one the user intended. The current result is a local search result. It does not guarantee the fewest displaced widgets across all possible layouts.

The same resolver also handles keyboard movement, keyboard resizing, pointer resizing, widget-requested sizing and type changes that require a larger widget. Those operations do not all have pointer face information. Free placement follows a separate pixel-based path and permits overlap. The tutorial uses the shared application grid behavior against mock data.

The existing `tests/grid-displacement.mjs` checks one unnecessary-chain scenario and one necessary keyboard chain. It does not establish face selection or the new insertion behavior.

## Proposed work

1. Use continuous cursor distance to finite target-face segments. Preserve the user's grip offset so a large widget can be placed without requiring the pointer to be at its corner. Apply the approved hysteresis and corner-tie rules.
2. Distinguish a free placement from an insertion request. A candidate that fits in empty space must not displace a neighbor unless the user has entered that neighbor's insertion region. Show which destination and push the current gesture will produce before release.
3. Pass explicit interaction intent into grid placement. Face selection must be able to change while the snapped rectangle stays the same. The selected face determines the primary push direction. It must not be inferred from the widget's starting position.
4. Place the dragged rectangle in a valid grid location and move the target away from its contacted face. Continue the push through actual rectangle collisions. Keep widget sizes intact. Avoid moving widgets that do not intersect the resulting push path. The rules for selecting among multiple valid layouts need agreement.
5. Keep preview and commit consistent. A valid preview should commit the same arrangement. An invalid or cancelled gesture should restore the starting arrangement. Update hit testing for click-to-carry as well as pointer dragging.
6. Define separate intent for keyboard moves and each resizing path. A keyboard move has an explicit arrow direction. A resize has expanding edges. Widget-requested sizing and type changes need a documented policy because they have no contact gesture. Preserve free placement behavior.
7. Add focused placement tests for all four faces and both empty-cell and insertion intent. Add browser tests for preview, drop, cancellation and click-to-carry. Exercise the same movement in the tutorial and the regular board. Check differently sized widgets and chains. Verify native behavior where board margins and pointer capture matter.

This is a proposed design rather than a fully specified algorithm. The face rule alone does not determine every placement when sizes differ or space is constrained. The choices below should be resolved before implementation.

## Edge cases and open decisions

1. **Corners and center.** The laboratory assigns every occupied point to a nearest face. Hysteresis controls preview flicker. Bounded feasibility and explicit clockwise priority resolve corner ties. Production thresholds still require use testing.
2. **Margin versus free cell.** A face region can extend into an adjacent empty cell. Decide its size and visual feedback so `(4,10)` can remain a free drop while D's left face can still request insertion.
3. **Board edges.** B's top face lies on the top row. Check whether the actual window permits the pointer to reach the outer margin. Provide an inner-face target when the outer margin cannot be reached. A pushed widget may have no space in the chosen direction.
4. **Blocked chosen direction.** A push may run into the board edge or a crowded chain. Decide whether to reject the drop or offer another arrangement. An automatic sideways fallback could contradict the chosen face.
5. **Large dragged widget.** A 3 × 2 widget can overlap a 1 × 1 target and other neighbors at once. Decide which target establishes intent and how much space each collision needs. A single-cell insertion example does not determine the result.
6. **Multiple target faces.** A large widget can contact several widgets at different faces. Decide whether to push them together in one direction or prioritize a target. Avoid a result that depends on widget array order.
7. **Misaligned rectangles.** A narrow widget may contact only part of a wider widget. The full target rectangle must move far enough to eliminate overlap. A downstream collision can involve only a portion of its face.
8. **Chain branching.** One pushed widget can hit several widgets. Each actual overlap may require a push. A widget separated by empty cells must not move just because it is somewhere along an extended row or column.
9. **Path versus destination.** A fast drag can pass over several widgets. Decide whether transient contact changes the final arrangement. The current system recomputes each preview from the saved starting layout.
10. **Grab offset and occlusion.** The pointer can be far from the dragged widget's leading edge. The dragged widget can cover a target face. Decide how geometry and pointer position combine without making the insertion target inaccessible.
11. **Hidden widgets.** Hidden widgets retain grid space and participate in the current resolver. Their role in insertion and preview must remain understandable.
12. **No valid layout or search limit.** A crowded board can have no valid result. A bounded search can also give up before finding one. Feedback must distinguish an invalid preview from a committed change. The policy for fallback and search limits needs definition.
13. **Keyboard and resizing.** Keyboard movement has no pointer face. A resize may grow on more than one axis. Programmatic sizing has no gesture. Their collision policies need explicit decisions and regression coverage.
14. **Pointer cancellation and layout changes.** Pointer cancellation, Escape, window resizing, cell-size changes and stale preview state can interrupt a drag. Define when to revert and verify no partial placement is saved.
15. **Tutorial completion.** The tutorial currently identifies a push when a valid move changes another widget's position. A face-based preview must not count as a completed push until a valid drop commits.
