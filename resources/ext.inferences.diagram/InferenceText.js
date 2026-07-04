/**
 * Pure wikitext helpers for the Inferences extension — no MediaWiki
 * dependencies. Everything the canvas writes into articles goes through
 * here, so the exact syntax lives in one place:
 *
 *   {{#inference:id=1|to=Compositor|tag=talks to|inferred=yes
 *     |evidence1=https://…|snippet1=…}}
 *   [[Category:Programs]]
 *
 * Values are escaped with {{!}} for "|" so tags/evidence can contain
 * pipes; the extension always writes single-line canonical calls.
 */
( function ( root, factory ) {
	if ( typeof module !== 'undefined' && module.exports ) {
		module.exports = factory();
	} else {
		root.InferencesText = factory();
	}
}( typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	var CALL_RE = /\{\{#inference:([\s\S]*?)\}\}/g;
	var CATEGORY_RE = /\[\[\s*Category\s*:\s*([^\]|]+?)\s*(?:\|[^\]]*)?\]\]\n?/gi;

	function escapeValue( value ) {
		return String( value )
			.replace( /\|/g, '{{!}}' )
			.replace( /\{\{#/g, '' )
			.replace( /\}\}/g, '' )
			.replace( /\r?\n/g, ' ' )
			.trim();
	}

	function unescapeValue( value ) {
		return String( value ).replace( /\{\{!\}\}/g, '|' ).trim();
	}

	/** Deterministic mid-tone color from a name, same on every client. */
	function hashColor( name ) {
		var hash = 0;
		var str = String( name );
		for ( var i = 0; i < str.length; i++ ) {
			hash = ( hash * 31 + str.charCodeAt( i ) ) >>> 0;
		}
		var hue = hash % 360;
		// hsl -> rgb with fixed s/l chosen to read on light and dark
		var s = 0.55;
		var l = 0.55;
		var c = ( 1 - Math.abs( 2 * l - 1 ) ) * s;
		var x = c * ( 1 - Math.abs( ( ( hue / 60 ) % 2 ) - 1 ) );
		var m = l - c / 2;
		var rgb = [ [ c, x, 0 ], [ x, c, 0 ], [ 0, c, x ],
			[ 0, x, c ], [ x, 0, c ], [ c, 0, x ] ][ Math.floor( hue / 60 ) % 6 ];
		return '#' + rgb.map( function ( v ) {
			return Math.round( ( v + m ) * 255 ).toString( 16 ).padStart( 2, '0' );
		} ).join( '' );
	}

	/**
	 * All inference calls in a page's wikitext.
	 * @return {Array} entries {id, from, to, tag, inferred, evidence[], start, end}
	 */
	function parse( wikitext ) {
		var out = [];
		var match;
		CALL_RE.lastIndex = 0;
		while ( ( match = CALL_RE.exec( wikitext ) ) !== null ) {
			var params = {};
			match[ 1 ].split( '|' ).forEach( function ( part ) {
				var eq = part.indexOf( '=' );
				if ( eq !== -1 ) {
					params[ part.slice( 0, eq ).trim() ] = unescapeValue( part.slice( eq + 1 ) );
				}
			} );
			var evidence = [];
			for ( var i = 1; params[ 'evidence' + i ] !== undefined ||
				params[ 'snippet' + i ] !== undefined; i++ ) {
				evidence.push( {
					source: params[ 'evidence' + i ] || '',
					snippet: params[ 'snippet' + i ] || ''
				} );
			}
			out.push( {
				id: params.id || String( out.length + 1 ),
				from: params.from || '',
				to: params.to || '',
				tag: params.tag || '',
				inferred: params.inferred === 'yes',
				evidence: evidence,
				start: match.index,
				end: match.index + match[ 0 ].length
			} );
		}
		return out;
	}

	/** Canonical single-line call for an entry. */
	function serialize( entry ) {
		var parts = [ 'id=' + escapeValue( entry.id ) ];
		if ( entry.from ) {
			parts.push( 'from=' + escapeValue( entry.from ) );
		}
		parts.push( 'to=' + escapeValue( entry.to ) );
		if ( entry.tag ) {
			parts.push( 'tag=' + escapeValue( entry.tag ) );
		}
		if ( entry.inferred ) {
			parts.push( 'inferred=yes' );
		}
		( entry.evidence || [] ).forEach( function ( ev, i ) {
			if ( ev.source || ev.snippet ) {
				parts.push( 'evidence' + ( i + 1 ) + '=' + escapeValue( ev.source ) );
				parts.push( 'snippet' + ( i + 1 ) + '=' + escapeValue( ev.snippet ) );
			}
		} );
		return '{{#inference:' + parts.join( '|' ) + '}}';
	}

	/** Smallest unused numeric id among the page's calls. */
	function nextId( wikitext ) {
		var max = 0;
		parse( wikitext ).forEach( function ( entry ) {
			var n = parseInt( entry.id, 10 );
			if ( !isNaN( n ) && n > max ) {
				max = n;
			}
		} );
		return String( max + 1 );
	}

	/** Replace the call with entry.id, or append a new call. */
	function upsert( wikitext, entry ) {
		var call = serialize( entry );
		var existing = parse( wikitext ).find( function ( e ) {
			return e.id === entry.id;
		} );
		if ( existing ) {
			return wikitext.slice( 0, existing.start ) + call + wikitext.slice( existing.end );
		}
		// insert before the first category link, else append
		CATEGORY_RE.lastIndex = 0;
		var cat = CATEGORY_RE.exec( wikitext );
		if ( cat ) {
			return wikitext.slice( 0, cat.index ) + call + '\n' + wikitext.slice( cat.index );
		}
		var sep = wikitext === '' ? '' : ( wikitext.endsWith( '\n' ) ? '' : '\n' );
		return wikitext + sep + call + '\n';
	}

	function remove( wikitext, id ) {
		var existing = parse( wikitext ).find( function ( e ) {
			return e.id === id;
		} );
		if ( !existing ) {
			return wikitext;
		}
		var end = existing.end;
		if ( wikitext[ end ] === '\n' ) {
			end++;
		}
		return wikitext.slice( 0, existing.start ) + wikitext.slice( end );
	}

	/** Category names (spaces normalized) present in the wikitext. */
	function getCategories( wikitext ) {
		var out = [];
		var match;
		CATEGORY_RE.lastIndex = 0;
		while ( ( match = CATEGORY_RE.exec( wikitext ) ) !== null ) {
			out.push( match[ 1 ].replace( /_/g, ' ' ).trim() );
		}
		return out;
	}

	/**
	 * Swap the page's type category: remove oldName (if given), add
	 * newName (if given). Other categories are left untouched.
	 */
	function replaceCategory( wikitext, oldName, newName ) {
		var text = wikitext;
		if ( oldName ) {
			var re = new RegExp(
				'\\[\\[\\s*Category\\s*:\\s*' +
				String( oldName ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ).replace( / /g, '[ _]' ) +
				'\\s*(?:\\|[^\\]]*)?\\]\\]\\n?', 'gi' );
			text = text.replace( re, '' );
		}
		if ( newName && getCategories( text ).indexOf( newName ) === -1 ) {
			var sep = text === '' ? '' : ( text.endsWith( '\n' ) ? '' : '\n' );
			text = text + sep + '[[Category:' + newName + ']]\n';
		}
		return text;
	}

	/** Rewrite to=/from= references after a page rename. */
	function renameReferences( wikitext, oldTitle, newTitle ) {
		var changed = false;
		var entries = parse( wikitext );
		for ( var i = entries.length - 1; i >= 0; i-- ) {
			var entry = entries[ i ];
			var touched = false;
			[ 'to', 'from' ].forEach( function ( key ) {
				var value = entry[ key ];
				if ( value === oldTitle ) {
					entry[ key ] = newTitle;
					touched = true;
				} else if ( value.indexOf( oldTitle + '#' ) === 0 ) {
					entry[ key ] = newTitle + value.slice( oldTitle.length );
					touched = true;
				}
			} );
			if ( touched ) {
				wikitext = wikitext.slice( 0, entry.start ) +
					serialize( entry ) + wikitext.slice( entry.end );
				changed = true;
			}
		}
		return changed ? wikitext : null;
	}

	return {
		parse: parse,
		serialize: serialize,
		upsert: upsert,
		remove: remove,
		nextId: nextId,
		getCategories: getCategories,
		replaceCategory: replaceCategory,
		renameReferences: renameReferences,
		hashColor: hashColor
	};
} ) );
