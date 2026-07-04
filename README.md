# Inferences

A MediaWiki extension for diagramming complex systems as a shared,
contributable wiki: **things** (nodes, optionally linked to wiki pages, with
optional shared **types** like "program"), tagged **relationships** between
them — including relationships *about* other relationships — and **evidence**
(source + snippet) attached to relationships, laid out by hand on an infinite
canvas so the spatial arrangement carries meaning.

Diagrams are ordinary wiki pages in a `Diagram:` namespace, stored as JSON
via a custom content model. That means every diagram automatically gets what
a wiki gives pages: **revision history, diffs, talk pages, watchlists, and
permissions** — nothing bespoke to run or maintain beyond MediaWiki itself.

## Installing

Requires MediaWiki **>= 1.43**. Clone straight into your extensions
directory (the directory must be named `Inferences`):

```sh
cd extensions
git clone https://github.com/technobaboo/inferences.git Inferences
```

Then add to `LocalSettings.php`:

```php
wfLoadExtension( 'Inferences' );
```

Create a page like `Diagram:My first diagram`, put `{}` in it, and click
**Edit diagram** in the canvas toolbar. Updating is `git pull`.

Hosted options work too: any host that allows custom extensions (e.g.
[ProWiki](https://www.pro.wiki/)) can run this.

## Features

- Infinite pannable/zoomable canvas with an adaptive grid
- **Right-click** empty space to add a thing; **right-drag** from a thing to
  connect it (release on empty space to create *and* connect a new thing)
- Relationships are curved edges carrying a **tag** (typed, colored, reusable
  across the diagram) and a list of **evidence** entries (source + snippet)
- Relationships can be marked **inferred** (deduced rather than directly
  observed) — drawn dashed with a "∴" marker
- **Relationships about relationships**: an edge's endpoint can be another
  edge (anchored at its label pill), so a "Unix domain socket" thing can be
  the *transport for* the "connects" relationship between two other things.
  Right-drag onto (or from) an edge exactly like a node; deleting anything
  cascades through edges attached to edges
- Things can carry a **type** (e.g. "program"): types have a shared name and
  color, so every program looks the same, and type names are fed to the wiki
  search index so `Special:Search` finds diagrams by type
- Things can **link to wiki pages** — readers click a node to follow the
  link, linked pages show the diagram under "What links here", and a thing's
  card can **edit the linked page's full source in place** (creating it if
  it doesn't exist)
- A thing's card also lists **all its relationships**, click to inspect each
- The canvas **follows the page's light/dark mode** — Vector 2022's night
  mode inside MediaWiki, `prefers-color-scheme` elsewhere — switching live
- **Pinnable inspector cards**: pin a thing's or relationship's card open and
  it stays visible for every reader — pins are saved in the document
- Undo/redo; saves are ordinary wiki revisions; raw JSON editing stays
  available through the normal edit action
- Embed any diagram read-only in an article:

  ```
  <inferences-diagram page="My system" height="480" />
  ```

## Developing without a wiki

The canvas is a standalone module with no MediaWiki dependency
(`resources/ext.inferences.diagram/Graph.js`; the thin adapter in `init.js`
is the only MediaWiki-aware code). Open `dev/preview.html` directly in a
browser to hack on the editor — it saves to localStorage, append `?fresh`
to reset.

## Document format

```jsonc
{
	"version": 1,
	"view": { "x": 0, "y": 0, "zoom": 1 },
	"tags": { "1": { "name": "causes", "color": "#e5484d" } },
	"types": { "6": { "name": "program", "color": "#46a758" } },
	"things": {
		"2": { "name": "Compositor", "color": "#3e63dd", "type": "6",
		        "x": 0, "y": 0, "pinned": false, "link": "Compositor" }
	},
	"relationships": {
		"3": { "from": "2", "to": "4", "tag": "1",
		        "hx": 10, "hy": 20, "hset": true, "inferred": false,
		        "pinned": false,
		        "evidence": [ { "source": "https://…", "snippet": "…" } ] }
	},
	"nextId": 7
}
```

`from`/`to` may name a thing **or another relationship** — things,
relationships, tags and types share one ID space, and a relationship
endpoint anchors at that edge's midpoint. Cycles and dangling endpoints are
dropped on load. `hx`/`hy` is the edge's curve handle; `hset` records
whether it was placed by hand (otherwise it follows its endpoints as they
move). IDs are never reused, so external annotations can reference them
stably.

## Roadmap

- **Observation overlays**: separate contributed layers (e.g.
  `Diagram:Foo/Observations/SomeUser` subpages) that reference a base
  diagram's stable thing/relationship IDs and record experienced input/output
  behavior, rendered as toggleable overlays so observations can be compared
  side by side
- Red-link styling for things linked to pages that don't exist yet
- i18n for editor UI strings (currently English, in `Graph.js`)
- Touch/mobile gesture support

## History

Inferences started as a native Rust + egui prototype; the canvas editor is a
faithful port of its scene (adaptive power-of-two grid, right-click to add,
pinning). The prototype lives in this repository's git history prior to the
extension restructure.
