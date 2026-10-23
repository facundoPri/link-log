# Linklog board review

Board: `../Linklog Pre-release.tldraw`
Document ID: `evuNpzrC0YL0YnTFPilBA`
Linear project: https://linear.app/facundopri/project/linklog-f69d633088ae

The initial board contains nine linked ticket cards, FAC-40 through FAC-48, grouped by topic, and a freeform notes area. All ticket statuses were Backlog when created.

`linklog-board-baseline.json` contains the initial raw shape records returned by the tldraw app. Use this baseline to identify added, edited, moved, or removed shapes when the user requests a review. This is a snapshot, not an edit history or automatic sync.

`linklog-board-details-baseline.json` is the newer snapshot after adding nine full-description cards below the notes area. Use it as the latest comparison baseline. It preserves the user's moved Browser extension heading and all previous shapes. Shapes with `meta.role: full-ticket-details` are detail copies of the same Linear tickets, not additional tickets.

For a review, use the tldraw-offline skill and locate this exact document by document ID or file path. Read all relevant shapes and available comments; inspect screenshots for handwriting and drawings. Compare the current records with the baseline, preserving the user's edits. Report uncertain handwriting rather than guessing. Check current Linear issues if the review involves task status. Only update Linear when requested. After an agreed review, a new dated snapshot can be saved alongside the original to support the next comparison.

The board needs to be open in tldraw offline for live API access. Do not repurpose another open document or directly edit the archive.

Latest review: `linklog-board-reviewed-baseline.json` supersedes the earlier snapshots for future change comparisons. Handwritten feedback was reviewed on 27 September 2026: FAC-40, FAC-44, FAC-45, FAC-46, and FAC-48 were revised in Linear; FAC-49 was created for payment-provider and cost-based plan research. All original shapes and handwriting were preserved. The updated details live to the right of the annotated originals with `meta.role: reviewed-ticket-details`. The earlier cards are historical annotated versions. The board currently has ten distinct Linear tickets; multiple cards may refer to the same issue.
