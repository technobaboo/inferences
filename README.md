# Inferences

Diagram complex systems as a shared, contributable wiki: **things** (nodes,
optionally linked to wiki pages), tagged **relationships** between them, and
**evidence** (source + snippet) attached to relationships — laid out by hand
on an infinite canvas, so the spatial arrangement carries meaning.

This repo contains two implementations of the same idea:

| Directory | What it is |
|---|---|
| `extension/` | **Inferences**, a MediaWiki extension — the collaborative web version |
| `src/` | The original native prototype (Rust + egui) |

## The MediaWiki extension

Diagrams are ordinary wiki pages in a `Diagram:` namespace, stored as JSON via
a custom content model. That means every diagram automatically gets what a
wiki gives pages: **revision history, diffs, talk pages, watchlists, and
permissions** — nothing bespoke to run or maintain beyond MediaWiki itself.

### Features

- Infinite pannable/zoomable canvas with an adaptive grid (a port of the
  native app's scene)
- **Right-click** empty space to add a thing; **right-drag** from a thing to
  connect it (release on empty space to create *and* connect a new thing)
- Relationships are curved edges carrying a **tag** (typed, colored, reusable
  across the diagram) and a list of **evidence** entries (source + snippet)
- **Relationships about relationships**: an edge's endpoint can be another
  edge (anchored at its label pill), so a "Unix domain socket" thing can be
  the *transport for* the "connects" relationship between two other things.
  Right-drag onto (or from) an edge exactly like a node; deleting anything
  cascades through edges attached to edges
- Things can **link to wiki pages** — readers click a node to follow the
  link, and linked pages show the diagram under "What links here"
- **Pinnable inspector cards**: pin a thing's or relationship's card open and
  it stays visible for every reader — pins are saved in the document
- Undo/redo, save-as-wiki-revision, raw JSON editing still available through
  the normal edit action
- Embed any diagram read-only in an article:

  ```
  <inferences-diagram page="My system" height="480" />
  ```

### Installing

Requires MediaWiki **>= 1.43**. Copy (or symlink) `extension/` into your wiki
as `extensions/Inferences`, then add to `LocalSettings.php`:

```php
wfLoadExtension( 'Inferences' );
```

Create a page like `Diagram:My first diagram` and click **Edit diagram** in
the canvas toolbar.

Hosted options work too: any host that allows custom extensions (e.g.
[ProWiki](https://www.pro.wiki/)) can run this. Bare `wikibase.cloud`-style
hosts that don't allow custom extensions cannot.

### Developing without a wiki

The canvas is a standalone module with no MediaWiki dependency
(`resources/ext.inferences.diagram/Graph.js`; the thin adapter in `init.js`
is the only MediaWiki-aware code). Open `extension/dev/preview.html` directly
in a browser to hack on the editor — it saves to localStorage, append
`?fresh` to reset.

### Document format

```jsonc
{
	"version": 1,
	"view": { "x": 0, "y": 0, "zoom": 1 },
	"tags": { "1": { "name": "causes", "color": "#e5484d" } },
	"things": {
		"2": { "name": "Compositor", "color": "#3e63dd",
		        "x": 0, "y": 0, "pinned": false, "link": "Compositor" }
	},
	"relationships": {
		"3": { "from": "2", "to": "4", "tag": "1",
		        "hx": 10, "hy": 20, "hset": true, "pinned": false,
		        "evidence": [ { "source": "https://…", "snippet": "…" } ] }
	},
	"nextId": 5
}
```

`from`/`to` may name a thing **or another relationship** — things,
relationships and tags share one ID space (as in the native app), and a
relationship endpoint anchors at that edge's midpoint. Cycles and dangling
endpoints are dropped on load. `hx`/`hy` is the edge's curve handle; `hset`
records whether it was placed by hand (otherwise it follows its endpoints as
they move). IDs are never reused, so external annotations can reference them
stably.

### Roadmap

- **Observation overlays**: separate contributed layers (e.g.
  `Diagram:Foo/Observations/SomeUser` subpages) that reference a base
  diagram's stable thing/relationship IDs and record experienced input/output
  behavior, rendered as toggleable overlays so observations can be compared
  side by side
- Red-link styling for things linked to pages that don't exist yet
- i18n for editor UI strings (currently English, in `Graph.js`)
- Touch/mobile gesture support

## The native prototype

The original Rust + egui app (`cargo run`). Same data model; the canvas port
in the extension follows its interactions (grid, middle-drag pan, right-click
add, pinning).
