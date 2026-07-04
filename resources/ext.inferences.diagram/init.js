/**
 * MediaWiki glue for the Inferences diagram canvas.
 *
 * Two hydration paths:
 *  - Diagram-namespace pages: the ContentHandler emits a container with
 *    the document JSON in data-inferences-doc. Editable in place; saving
 *    writes the JSON back with action=edit, so every save is an ordinary
 *    wiki revision.
 *  - <inferences-diagram page="…"/> embeds: the container carries
 *    data-inferences-page; the document is fetched via the API and
 *    rendered read-only.
 */
'use strict';

var Graph = require( './Graph.js' );

function resolveHref( title ) {
	return mw.util.getUrl( title );
}

function navigate( title ) {
	window.location.href = mw.util.getUrl( title );
}

/**
 * Vector 2022's night mode stamps skin-theme-clientpref-night (forced
 * dark) or skin-theme-clientpref-os (follow the OS) on <html>. Minerva
 * uses the same client preference classes.
 */
function wikiIsDark() {
	var classes = document.documentElement.classList;
	if ( classes.contains( 'skin-theme-clientpref-night' ) ) {
		return true;
	}
	if ( classes.contains( 'skin-theme-clientpref-os' ) ) {
		return window.matchMedia &&
			window.matchMedia( '(prefers-color-scheme: dark)' ).matches;
	}
	return false;
}

/** Re-theme a graph whenever the skin theme class on <html> changes. */
function followWikiTheme( graph ) {
	var observer = new MutationObserver( function () {
		graph.refreshTheme();
	} );
	observer.observe( document.documentElement, {
		attributes: true,
		attributeFilter: [ 'class' ]
	} );
}

function notify( message, isError ) {
	mw.notify( message, isError ? { type: 'error' } : undefined );
}

var pageApi = {
	load: function ( title ) {
		return new mw.Api().get( {
			action: 'query',
			prop: 'revisions',
			titles: title,
			rvprop: [ 'content' ],
			rvslots: 'main',
			formatversion: 2
		} ).then( function ( res ) {
			var p = res.query && res.query.pages && res.query.pages[ 0 ];
			if ( !p || p.missing || !p.revisions ) {
				return { exists: false, text: '' };
			}
			return { exists: true, text: p.revisions[ 0 ].slots.main.content };
		} );
	},
	save: function ( title, text ) {
		return new mw.Api().postWithEditToken( {
			action: 'edit',
			title: title,
			text: text,
			summary: 'Edited from an Inferences diagram'
		} );
	}
};

function initDiagramPage( container ) {
	var doc;
	try {
		doc = JSON.parse( container.getAttribute( 'data-inferences-doc' ) );
	} catch ( e ) {
		return;
	}
	container.classList.add( 'ext-inferences-diagram-page' );

	var graph = new Graph( container, {
		doc: doc,
		editable: false,
		resolveHref: resolveHref,
		navigate: navigate,
		isDark: wikiIsDark,
		pageApi: pageApi,
		notify: notify,
		onDirtyChange: function ( dirty ) {
			if ( saveBtn ) {
				saveBtn.disabled = !dirty;
				saveBtn.textContent = dirty ? 'Save changes' : 'Saved';
			}
		}
	} );
	followWikiTheme( graph );
	// dev/testing affordance: reach the instance from the console
	container.infGraph = graph;

	if ( !mw.config.get( 'wgIsProbablyEditable' ) ) {
		return;
	}

	var originalJson = JSON.stringify( graph.getDoc() );
	var editBtn, saveBtn, cancelBtn;

	function setEditing( editing ) {
		graph.setEditable( editing );
		editBtn.style.display = editing ? 'none' : '';
		saveBtn.style.display = editing ? '' : 'none';
		cancelBtn.style.display = editing ? '' : 'none';
	}

	editBtn = graph.addToolbarButton( 'Edit diagram', function () {
		originalJson = JSON.stringify( graph.getDoc() );
		setEditing( true );
	}, { primary: true } );

	saveBtn = graph.addToolbarButton( 'Save changes', function () {
		saveBtn.disabled = true;
		saveBtn.textContent = 'Saving…';
		new mw.Api().postWithEditToken( {
			action: 'edit',
			title: mw.config.get( 'wgPageName' ),
			text: graph.getDocJson(),
			summary: 'Edited with the Inferences diagram editor'
		} ).done( function () {
			graph.markSaved();
			originalJson = JSON.stringify( graph.getDoc() );
			saveBtn.textContent = 'Saved';
			mw.notify( 'Diagram saved.' );
		} ).fail( function ( code ) {
			saveBtn.disabled = false;
			saveBtn.textContent = 'Save changes';
			mw.notify( 'Saving failed: ' + code, { type: 'error' } );
		} );
	}, { primary: true } );
	saveBtn.style.display = 'none';
	saveBtn.disabled = true;
	saveBtn.textContent = 'Saved';

	cancelBtn = graph.addToolbarButton( 'Cancel', function () {
		graph.setDoc( JSON.parse( originalJson ) );
		setEditing( false );
	} );
	cancelBtn.style.display = 'none';

	window.addEventListener( 'beforeunload', function ( e ) {
		if ( graph.dirty ) {
			e.preventDefault();
			e.returnValue = '';
		}
	} );
}

function initEmbed( container ) {
	var page = container.getAttribute( 'data-inferences-page' );
	var height = parseInt( container.getAttribute( 'data-inferences-height' ), 10 ) || 480;
	container.style.height = height + 'px';

	new mw.Api().get( {
		action: 'query',
		prop: 'revisions',
		titles: page,
		rvprop: [ 'content' ],
		rvslots: 'main',
		formatversion: 2
	} ).done( function ( res ) {
		var pageData = res.query && res.query.pages && res.query.pages[ 0 ];
		var rev = pageData && !pageData.missing &&
			pageData.revisions && pageData.revisions[ 0 ];
		var content = rev && rev.slots && rev.slots.main && rev.slots.main.content;
		if ( !content ) {
			container.textContent = 'Diagram not found: ' + page;
			container.classList.add( 'ext-inferences-diagram-error' );
			return;
		}
		var doc;
		try {
			doc = JSON.parse( content );
		} catch ( e ) {
			container.textContent = 'Not a valid diagram: ' + page;
			container.classList.add( 'ext-inferences-diagram-error' );
			return;
		}
		var graph = new Graph( container, {
			doc: doc,
			editable: false,
			resolveHref: resolveHref,
			navigate: navigate,
			isDark: wikiIsDark
		} );
		followWikiTheme( graph );
		var open = graph.addToolbarButton( '⧉ ' + page, function () {
			window.location.href = mw.util.getUrl( page );
		} );
		open.title = 'Open the diagram page';
	} ).fail( function () {
		container.textContent = 'Could not load diagram: ' + page;
		container.classList.add( 'ext-inferences-diagram-error' );
	} );
}

mw.hook( 'wikipage.content' ).add( function ( $content ) {
	$content[ 0 ].querySelectorAll( '.ext-inferences-diagram' ).forEach( function ( node ) {
		if ( node.dataset.inferencesInitialized ) {
			return;
		}
		node.dataset.inferencesInitialized = '1';
		if ( node.hasAttribute( 'data-inferences-doc' ) ) {
			initDiagramPage( node );
		} else if ( node.hasAttribute( 'data-inferences-page' ) ) {
			initEmbed( node );
		}
	} );
} );
