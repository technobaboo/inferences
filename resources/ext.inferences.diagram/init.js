/**
 * MediaWiki glue for the Inferences canvas.
 *
 * Two hydration paths:
 *  - Diagram-namespace pages: the ContentHandler emits a container with
 *    the view definition JSON (scope category, manual pages, layout) in
 *    data-inferences-view. The WikiStore loads the actual graph from
 *    the member pages' wikitext; semantic edits become immediate page
 *    edits, layout is saved back to the view page with "Save layout".
 *  - <inferences-diagram page="…"/> embeds: the container carries
 *    data-inferences-page; the view definition is fetched via the API
 *    and rendered read-only.
 */
'use strict';

var Graph = require( './Graph.js' );
var WikiStore = require( './WikiStore.js' );

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
	},
	render: function ( title ) {
		return new mw.Api().get( {
			action: 'parse',
			page: title,
			prop: 'text',
			redirects: true,
			disablelimitreport: true,
			disableeditsection: true,
			disabletoc: true,
			formatversion: 2
		} ).then( function ( res ) {
			return ( res.parse && res.parse.text ) || '';
		} );
	}
};

function showError( container, message ) {
	container.textContent = message;
	container.classList.add( 'ext-inferences-diagram-error' );
}

function initDiagramPage( container ) {
	var viewDoc;
	try {
		viewDoc = JSON.parse( container.getAttribute( 'data-inferences-view' ) );
	} catch ( e ) {
		return;
	}
	container.classList.add( 'ext-inferences-diagram-page' );

	var viewTitle = mw.config.get( 'wgPageName' ).replace( /_/g, ' ' );
	var store = new WikiStore( { viewTitle: viewTitle, viewDoc: viewDoc } );
	var saveBtn;

	store.load().then( function ( doc ) {
		var graph = new Graph( container, {
			store: store,
			doc: doc,
			editable: false,
			resolveHref: resolveHref,
			navigate: navigate,
			isDark: wikiIsDark,
			pageApi: pageApi,
			renderPage: pageApi.render,
			notify: notify,
			onDirtyChange: function ( dirty ) {
				if ( saveBtn ) {
					saveBtn.disabled = !dirty;
					saveBtn.textContent = dirty ? 'Save layout' : 'Layout saved';
				}
			}
		} );
		store.attach( graph );
		followWikiTheme( graph );
		// dev/testing affordance: reach the instance from the console
		container.infGraph = graph;
		container.infStore = store;

		if ( !mw.config.get( 'wgIsProbablyEditable' ) ) {
			return;
		}

		var editBtn, doneBtn;

		function setEditing( editing ) {
			graph.setEditable( editing );
			editBtn.style.display = editing ? 'none' : '';
			saveBtn.style.display = editing ? '' : 'none';
			doneBtn.style.display = editing ? '' : 'none';
		}

		editBtn = graph.addToolbarButton( 'Edit view', function () {
			setEditing( true );
		}, { primary: true } );

		saveBtn = graph.addToolbarButton( 'Layout saved', function () {
			saveBtn.disabled = true;
			saveBtn.textContent = 'Saving…';
			store.saveLayout().then( function () {
				graph.markLayoutSaved();
				saveBtn.textContent = 'Layout saved';
				mw.notify( 'Layout saved.' );
			}, function ( err ) {
				saveBtn.disabled = false;
				saveBtn.textContent = 'Save layout';
				mw.notify( 'Saving layout failed: ' + err, { type: 'error' } );
			} );
		}, { primary: true } );
		saveBtn.style.display = 'none';
		saveBtn.disabled = true;

		doneBtn = graph.addToolbarButton( 'Done', function () {
			setEditing( false );
		} );
		doneBtn.style.display = 'none';

		window.addEventListener( 'beforeunload', function ( e ) {
			if ( graph.layoutDirty ) {
				e.preventDefault();
				e.returnValue = '';
			}
		} );
	}, function ( err ) {
		showError( container, 'Could not load the diagram: ' + err );
	} );
}

function initEmbed( container ) {
	var page = container.getAttribute( 'data-inferences-page' );
	var height = parseInt( container.getAttribute( 'data-inferences-height' ), 10 ) || 480;
	container.style.height = height + 'px';

	pageApi.load( page ).then( function ( result ) {
		if ( !result.exists ) {
			showError( container, 'Diagram not found: ' + page );
			return;
		}
		var viewDoc;
		try {
			viewDoc = JSON.parse( result.text );
		} catch ( e ) {
			showError( container, 'Not a valid diagram: ' + page );
			return;
		}
		var store = new WikiStore( { viewTitle: page, viewDoc: viewDoc } );
		return store.load().then( function ( doc ) {
			var graph = new Graph( container, {
				store: store,
				doc: doc,
				editable: false,
				resolveHref: resolveHref,
				navigate: navigate,
				isDark: wikiIsDark,
				renderPage: pageApi.render
			} );
			store.attach( graph );
			followWikiTheme( graph );
			var open = graph.addToolbarButton( '⧉ ' + page, function () {
				window.location.href = mw.util.getUrl( page );
			} );
			open.title = 'Open the diagram page';
		} );
	} ).catch( function ( err ) {
		showError( container, 'Could not load diagram: ' + page + ' (' + err + ')' );
	} );
}

mw.hook( 'wikipage.content' ).add( function ( $content ) {
	$content[ 0 ].querySelectorAll( '.ext-inferences-diagram' ).forEach( function ( node ) {
		if ( node.dataset.inferencesInitialized ) {
			return;
		}
		node.dataset.inferencesInitialized = '1';
		if ( node.hasAttribute( 'data-inferences-view' ) ) {
			initDiagramPage( node );
		} else if ( node.hasAttribute( 'data-inferences-page' ) ) {
			initEmbed( node );
		}
	} );
} );
