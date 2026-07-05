# Inferences

A MediaWiki extension that turns the wiki itself into a hand-laid-out
system diagram. The canvas is an **interface over real wiki pages**, not an
editor for its own document format:

- A **thing** on the canvas *is* a wiki page. Creating a thing creates the
  page; renaming a thing moves it (redirect included); clicking it opens it.
- A **relationship** is a `{{#inference:…}}` call written into the source
  article's own wikitext — visible in the article as an inline chip,
  versioned with the page, revertable like any edit, and hand-editable.
- A relationship's endpoint can be **another relationship** (reification):
  `to=Wayland client#1` points at inference #1 on the "Wayland client"
  page, so a "Unix domain socket" can be the *transport for* the edge
  between a client and a compositor. Meta-edges anchor at the target
  edge's label pill.
- Relationships can be marked **inferred** (`inferred=yes` — deduced, not
  directly observed), drawn dashed with a "∴" marker, and carry
  **evidence** as ordinary `<ref>…</ref>` citations placed right after the
  call — rendered as footnotes by the wiki's built-in citation system.
- A thing's **type** is a category: typing something as "Programs" adds
  `[[Category:Programs]]` to its page. A category becomes a type by
  carrying `{{#inferencetype: color=#46a758}}` on its category page (the
  canvas creates this automatically for new types). All things of a type
  share its color; colors default to a hash of the name so they are
  consistent everywhere without configuration.
- A `Diagram:` page defines a **view**: a scope category whose members
  appear automatically, manually added pages, and the layout (positions,
  curve handles, pinned cards, pan/zoom) — the only data that belongs to
  the view rather than to the wiki. Pages referenced by inferences but
  outside the view appear as ghost nodes; missing pages render dashed in
  red-link color.

Because everything semantic lives on ordinary pages, every canvas edit is
an ordinary wiki edit with a descriptive summary — watchlists, diffs,
history, talk pages, permissions and search all just work.

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

Create a page like `Diagram:System map` with content:

```json
{
	"version": 2,
	"category": "My topic",
	"pages": []
}
```

The canvas shows every page in `Category:My topic`; click **Edit view** to
start drawing. Updating the extension is `git pull`.

To show the **whole wiki** instead of one category (there is no built-in
"category of all pages" in MediaWiki), use:

```json
{
	"version": 2,
	"allPages": true,
	"pages": []
}
```

This scopes the view to every page in the main namespace (redirects
excluded, first 500 pages). `"category": "*"` is accepted as a shorthand.

To put a diagram on your Main Page (or any article):

```
<inferences-diagram page="System map" height="600" />
```

## Editing

| Gesture | Effect |
|---|---|
| right-click empty space | create a page (and add it to the view) |
| right-drag thing → thing | write an inference into the source article |
| right-drag thing → edge pill | relationship *about* a relationship |
| right-drag onto empty space | create a new page and connect it |
| click a thing/edge | inspector card (pin 📌 to keep open for readers) |
| drag the diamond | reshape a selected edge (layout) |
| Delete | edge: remove the inference call; thing: remove from view |

Semantic edits (connect, tag, inferred, citations, type, rename, create)
apply to the pages **immediately**. Layout changes are batched behind the
**Save layout** button and go to the Diagram page. To undo a semantic
edit, use the page's history like any wiki edit.

The thing card also lists all of the page's relationships and can edit the
page's full wikitext source in place. Removing a category-scoped page from
a view isn't possible from the canvas — remove the category from the page
instead (the error message says so).

The canvas follows the page's light/dark mode (Vector 2022 night mode,
or `prefers-color-scheme` elsewhere), switching live.

## The wikitext

Everything the canvas writes is plain, hand-editable syntax:

```wikitext
A Wayland client application.

{{#inference:id=1|to=Compositor|tag=talks to|inferred=yes}}<ref>[https://wayland.freedesktop.org/docs/html/ wl_surface.commit is atomic.]</ref>

== References ==
<references />
[[Category:Wayland]]
```

Evidence is expressed with the wiki's built-in citation system: each
`<ref>…</ref>` glued to a call renders as a footnote (the canvas adds a
`<references />` section automatically the first time a page gains one).
Consecutive relationships are separated by a blank line so each chip
renders on its own paragraph.

`id` is stable per page and never reused, so `Page#id` references stay
valid; `to=`/`from=` accept `Title`, `Title#id`, or `#id` (an inference on
the same page). Values containing `|` are escaped as `{{!}}`. The parser
function renders an inline chip, registers the target as a page link
(so "What links here" works), and exposes all of a page's inferences in
the `inferences` page property for queries.

## Developing without a wiki

`resources/ext.inferences.diagram/Graph.js` (canvas) and
`InferenceText.js` (wikitext parsing/serialization) have no MediaWiki
dependencies; `WikiStore.js` + `init.js` are the only MediaWiki-aware
code. Open `dev/preview.html` in a browser to hack on the editor against
a mock in-memory wiki that uses the same wikitext code — state persists in
localStorage, append `?fresh` to reset.

## Roadmap

- **Observation overlays**: contributed layers recording experienced
  input/output behavior against stable `Page#id` references, rendered as
  toggleable overlays for comparison
- Incoming inferences from pages outside the view (via the `inferences`
  page property + backlinks)
- i18n for editor UI strings and localized `Category:` prefixes
- Touch/mobile gesture support

## History

Inferences started as a native Rust + egui prototype, then a wiki-stored
document editor; both live in this repository's git history. The current
architecture stores nothing semantic of its own — the wiki is the graph.
