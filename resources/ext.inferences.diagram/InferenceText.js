/**
 * Pure wikitext helpers for the Inferences extension — no MediaWiki
 * dependencies. Everything the canvas writes into articles goes through
 * here, so the exact syntax lives in one place:
 *
 *   {{#inference:id=1|to=Compositor|tag=talks to|inferred=yes}}<ref>…</ref>
 *
 *   [[Category:Programs]]
 *
 * Evidence uses the wiki's built-in citation system: <ref>…</ref> tags are
 * glued to the call and belong to the relationship. Param values are
 * escaped with {{!}} for "|" so tags can contain pipes; the extension
 * always writes single-line canonical calls, separated by a blank line so
 * each renders as its own paragraph. Legacy evidenceN/snippetN params are
 * still read and migrated to <ref> the next time a call is written.
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

	/**
	 * Read <ref>…</ref> citations glued to the end of an inference call.
	 * Ref bodies are collected into `evidence`; returns the index just past
	 * the last consumed ref (or `pos` if there are none). A blank line
	 * between the call and a ref detaches it, so only citations that belong
	 * to the relationship are captured.
	 */
	function readRefs( wikitext, pos, evidence ) {
		var re = /^[ \t]*\n?[ \t]*<ref(?:\s[^>]*)?>([\s\S]*?)<\/ref>/;
		var end = pos;
		var match;
		while ( ( match = re.exec( wikitext.slice( end ) ) ) !== null ) {
			evidence.push( match[ 1 ].trim() );
			end += match[ 0 ].length;
		}
		return end;
	}

	/** Turn a legacy evidence/snippet pair into citation wikitext. */
	function legacyCitation( source, snippet ) {
		source = String( source === undefined ? '' : source ).trim();
		snippet = String( snippet === undefined ? '' : snippet ).trim();
		if ( !source && !snippet ) {
			return '';
		}
		if ( /^https?:\/\//i.test( source ) ) {
			return snippet ? '[' + source + ' ' + snippet + ']' : source;
		}
		if ( source && snippet ) {
			return snippet + ' — ' + source;
		}
		return source || snippet;
	}

	/**
	 * Ensure a page that carries <ref> citations also has somewhere for
	 * them to render. No-op when there are no refs or a references list
	 * already exists; otherwise appends a References section (before the
	 * category links, by convention).
	 */
	function ensureReferences( wikitext ) {
		if ( !/<ref[\s>]/.test( wikitext ) ) {
			return wikitext;
		}
		if ( /<references|\{\{\s*(?:reflist|references)\b/i.test( wikitext ) ) {
			return wikitext;
		}
		var block = '== References ==\n<references />\n';
		CATEGORY_RE.lastIndex = 0;
		var cat = CATEGORY_RE.exec( wikitext );
		if ( cat ) {
			var before = wikitext.slice( 0, cat.index );
			var lead = before.endsWith( '\n\n' ) ? '' :
				( before.endsWith( '\n' ) ? '\n' : '\n\n' );
			return before + lead + block + '\n' + wikitext.slice( cat.index );
		}
		var sep = wikitext === '' ? '' :
			( wikitext.endsWith( '\n' ) ? '\n' : '\n\n' );
		return wikitext + sep + block;
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
			// Citations: <ref>…</ref> tags glued to the call, plus any legacy
			// evidenceN/snippetN params (migrated to <ref> on next write).
			var evidence = [];
			var refEnd = readRefs( wikitext, match.index + match[ 0 ].length, evidence );
			for ( var i = 1; params[ 'evidence' + i ] !== undefined ||
				params[ 'snippet' + i ] !== undefined; i++ ) {
				var legacy = legacyCitation( params[ 'evidence' + i ], params[ 'snippet' + i ] );
				if ( legacy ) {
					evidence.push( legacy );
				}
			}
			out.push( {
				id: params.id || String( out.length + 1 ),
				from: params.from || '',
				to: params.to || '',
				tag: params.tag || '',
				inferred: params.inferred === 'yes',
				evidence: evidence,
				start: match.index,
				end: refEnd
			} );
			CALL_RE.lastIndex = refEnd;
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
		var call = '{{#inference:' + parts.join( '|' ) + '}}';
		// Evidence uses the built-in citation system: each item becomes a
		// <ref> glued to the call so it renders as a footnote on the page.
		( entry.evidence || [] ).forEach( function ( ev ) {
			var body = typeof ev === 'string' ?
				ev.trim() : legacyCitation( ev && ev.source, ev && ev.snippet );
			if ( body ) {
				call += '<ref>' + body + '</ref>';
			}
		} );
		return call;
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
			return ensureReferences(
				wikitext.slice( 0, existing.start ) + call + wikitext.slice( existing.end ) );
		}
		// Insert before the first category link, else append — separated
		// from surrounding content by a blank line so each relationship
		// renders as its own paragraph (chip on its own line) instead of
		// running together with the next.
		CATEGORY_RE.lastIndex = 0;
		var cat = CATEGORY_RE.exec( wikitext );
		if ( cat ) {
			var before = wikitext.slice( 0, cat.index );
			var lead = before === '' ? '' :
				( before.endsWith( '\n\n' ) ? '' : ( before.endsWith( '\n' ) ? '\n' : '\n\n' ) );
			return ensureReferences(
				before + lead + call + '\n\n' + wikitext.slice( cat.index ) );
		}
		var sep = wikitext === '' ? '' :
			( wikitext.endsWith( '\n\n' ) ? '' : ( wikitext.endsWith( '\n' ) ? '\n' : '\n\n' ) );
		return ensureReferences( wikitext + sep + call + '\n' );
	}

	function remove( wikitext, id ) {
		var existing = parse( wikitext ).find( function ( e ) {
			return e.id === id;
		} );
		if ( !existing ) {
			return wikitext;
		}
		// Drop the call (and its citations) plus the trailing newline and
		// the blank-line separator we inserted, if present.
		var end = existing.end;
		if ( wikitext[ end ] === '\n' ) {
			end++;
		}
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
