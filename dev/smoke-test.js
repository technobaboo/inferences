/**
 * Headless smoke test for the Inferences canvas.
 *
 * Loads dev/preview.html in real Chromium (via Playwright) so the actual
 * Graph.js + InferenceText.js run against the mock wiki, then asserts that
 * the graph loads its things and relationships and that a full render pass
 * completes without throwing. A render-time exception (e.g. a variable
 * shadowing the 2D context) aborts drawing and leaves the canvas blank
 * while the data still looks fine — the kind of bug unit tests on the
 * wikitext layer miss, so we drive the browser here.
 *
 * Requires Playwright with a Chromium build available:
 *   npm install --no-save playwright   # or have it on NODE_PATH
 * Run:
 *   node dev/smoke-test.js
 * Exits non-zero on any failed assertion or runtime error.
 */
'use strict';

const path = require( 'path' );
const { chromium } = require( 'playwright' );

function assert( cond, msg ) {
	if ( !cond ) {
		throw new Error( 'Assertion failed: ' + msg );
	}
}

( async () => {
	const errors = [];
	const browser = await chromium.launch();
	const page = await browser.newPage();
	page.on( 'pageerror', ( e ) => errors.push( 'pageerror: ' + e.message ) );
	page.on( 'console', ( m ) => {
		if ( m.type() === 'error' ) {
			errors.push( 'console.error: ' + m.text() );
		}
	} );

	// ?fresh ignores any persisted localStorage and seeds the sample wiki.
	const url = 'file://' + path.resolve( __dirname, 'preview.html' ) + '?fresh';
	await page.goto( url );
	await page.waitForFunction( 'window.graph && window.store && window.store.doc',
		{ timeout: 10000 } );

	const loaded = await page.evaluate( () => ( {
		things: Object.keys( window.store.doc.things ).length,
		rels: Object.keys( window.store.doc.relationships ).length
	} ) );
	console.log( 'loaded things:', loaded.things, 'relationships:', loaded.rels );
	assert( loaded.things > 0, 'graph loaded at least one thing' );
	assert( loaded.rels > 0, 'graph loaded at least one relationship' );

	// Exercise the context field end to end: set it, force a re-render, then
	// reload from the resulting wikitext and confirm nothing was dropped.
	const relId = await page.evaluate( () => Object.keys( window.store.doc.relationships )[ 0 ] );
	const afterEdit = await page.evaluate( async ( id ) => {
		await window.store.updateEdge( id, { context: 'only when the client is focused' } );
		window.graph._scheduleRender();
		await new Promise( ( r ) => requestAnimationFrame( () => r() ) );
		const doc = await window.store.load();
		return {
			things: Object.keys( doc.things ).length,
			rels: Object.keys( doc.relationships ).length,
			context: doc.relationships[ id ] && doc.relationships[ id ].context
		};
	}, relId );
	console.log( 'after context edit + reload  things:', afterEdit.things,
		'relationships:', afterEdit.rels, 'context:', JSON.stringify( afterEdit.context ) );
	assert( afterEdit.things === loaded.things, 'no things lost after a context edit' );
	assert( afterEdit.rels === loaded.rels, 'no relationships lost after a context edit' );
	assert( afterEdit.context === 'only when the client is focused',
		'context round-trips through the wikitext' );

	await browser.close();

	if ( errors.length ) {
		console.error( '\nRuntime errors during render:\n' + errors.join( '\n' ) );
		process.exit( 1 );
	}
	console.log( '\nOK: canvas renders things + relationships with no runtime errors.' );
	process.exit( 0 );
} )().catch( ( e ) => {
	console.error( e );
	process.exit( 1 );
} );
