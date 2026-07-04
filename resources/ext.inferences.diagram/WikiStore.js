/**
 * WikiStore — the wiki-backed store for the Inferences canvas.
 *
 * The wiki IS the graph: things are pages, relationships are
 * {{#inference:…}} calls in those pages' wikitext, types are categories
 * (marked with {{#inferencetype:…}} on the category page). Every
 * semantic mutation here is an immediate, ordinary wiki edit with a
 * descriptive summary. Only layout is stored on the Diagram view page.
 *
 * View membership = the view's scope category's members
 *                 ∪ manually added pages
 *                 ∪ pages that already have a stored position
 *                 ∪ targets referenced by members' inferences (as
 *                   dashed "ghost" nodes, red when the page is missing).
 */
( function () {
	'use strict';

	var Text = require( './InferenceText.js' );

	function normalizeView( raw ) {
		raw = ( raw && typeof raw === 'object' ) ? raw : {};
		var view = {
			version: 2,
			// scope: one category, or the whole main namespace
			// ("allPages": true, or the shorthand "category": "*")
			allPages: raw.allPages === true || raw.category === '*',
			category: ( typeof raw.category === 'string' && raw.category !== '*' ) ?
				raw.category.trim() : '',
			pages: Array.isArray( raw.pages ) ? raw.pages.filter( function ( p ) {
				return typeof p === 'string' && p.trim() !== '';
			} ) : [],
			view: {
				x: Number( raw.view && raw.view.x ) || 0,
				y: Number( raw.view && raw.view.y ) || 0,
				zoom: Number( raw.view && raw.view.zoom ) || 1
			},
			things: {},
			edges: {}
		};
		Object.keys( raw.things || {} ).forEach( function ( title ) {
			var t = raw.things[ title ] || {};
			view.things[ title ] = {
				x: Number( t.x ) || 0,
				y: Number( t.y ) || 0,
				pinned: !!t.pinned
			};
		} );
		Object.keys( raw.edges || {} ).forEach( function ( id ) {
			var e = raw.edges[ id ] || {};
			view.edges[ id ] = {
				hx: Number( e.hx ) || 0,
				hy: Number( e.hy ) || 0,
				hset: !!e.hset,
				pinned: !!e.pinned
			};
		} );
		return view;
	}

	function chunk( arr, size ) {
		var out = [];
		for ( var i = 0; i < arr.length; i += size ) {
			out.push( arr.slice( i, i + size ) );
		}
		return out;
	}

	function apiError( err ) {
		return new Error( typeof err === 'string' ? err : 'API request failed' );
	}

	/**
	 * @param {Object} config { viewTitle, viewDoc }
	 */
	function WikiStore( config ) {
		this.api = new mw.Api();
		this.viewTitle = config.viewTitle;
		this.viewDoc = normalizeView( config.viewDoc );
		this.wikitext = {}; // title -> source of pages we may edit
		this.missing = {}; // title -> bool
		this.typeColors = {}; // category name -> '#rrggbb'
		this.categories = {}; // title -> [category names]
		this.tags = [];
		this.graph = null;
		this.doc = null;
	}

	WikiStore.prototype.attach = function ( graph ) {
		this.graph = graph;
	};

	WikiStore.prototype.knownTags = function () {
		return this.tags.slice().sort();
	};

	WikiStore.prototype.knownTypes = function () {
		return Object.keys( this.typeColors ).sort();
	};

	WikiStore.prototype.tagColor = function ( name ) {
		return Text.hashColor( name );
	};

	WikiStore.prototype.typeColor = function ( name ) {
		return this.typeColors[ name ] || Text.hashColor( name );
	};

	// ---- loading ------------------------------------------------------------

	WikiStore.prototype.load = function () {
		var self = this;
		var members = {};
		this.viewDoc.pages.forEach( function ( t ) {
			members[ t ] = true;
		} );
		Object.keys( this.viewDoc.things ).forEach( function ( t ) {
			members[ t ] = true;
		} );

		var start;
		if ( this.viewDoc.allPages ) {
			start = this.api.get( {
				action: 'query',
				list: 'allpages',
				apnamespace: 0,
				apfilterredir: 'nonredirects',
				aplimit: 500,
				formatversion: 2
			} ).then( function ( res ) {
				( res.query.allpages || [] ).forEach( function ( m ) {
					members[ m.title ] = true;
				} );
			} );
		} else if ( this.viewDoc.category ) {
			start = this.api.get( {
				action: 'query',
				list: 'categorymembers',
				cmtitle: 'Category:' + this.viewDoc.category,
				cmnamespace: 0,
				cmlimit: 500,
				formatversion: 2
			} ).then( function ( res ) {
				( res.query.categorymembers || [] ).forEach( function ( m ) {
					members[ m.title ] = true;
				} );
			} );
		} else {
			start = Promise.resolve();
		}

		return Promise.resolve( start ).then( function () {
			return self._fetchPages( Object.keys( members ) );
		} ).then( function () {
			// pull in edge targets outside the membership as ghost nodes
			var extra = {};
			Object.keys( members ).forEach( function ( title ) {
				if ( self.missing[ title ] ) {
					return;
				}
				Text.parse( self.wikitext[ title ] || '' ).forEach( function ( entry ) {
					[ entry.to, entry.from ].forEach( function ( ref ) {
						if ( !ref || ref[ 0 ] === '#' ) {
							return;
						}
						var page = ref.split( '#' )[ 0 ];
						if ( !members[ page ] && !extra[ page ] ) {
							extra[ page ] = true;
						}
					} );
				} );
			} );
			self._ghosts = extra;
			return self._fetchPages( Object.keys( extra ) );
		} ).then( function () {
			return self._fetchTypeCategories();
		} ).then( function () {
			self.doc = self._buildDoc(
				Object.keys( members ).concat( Object.keys( self._ghosts || {} ) ) );
			return self.doc;
		} );
	};

	/** Fetch wikitext + categories + existence for titles into the caches. */
	WikiStore.prototype._fetchPages = function ( titles ) {
		var self = this;
		titles = titles.filter( function ( t ) {
			return !( t in self.wikitext ) && !( t in self.missing );
		} );
		if ( !titles.length ) {
			return Promise.resolve();
		}
		return Promise.all( chunk( titles, 50 ).map( function ( batch ) {
			return self.api.get( {
				action: 'query',
				titles: batch,
				prop: 'revisions|categories',
				rvprop: 'content',
				rvslots: 'main',
				cllimit: 'max',
				formatversion: 2
			} ).then( function ( res ) {
				( res.query.pages || [] ).forEach( function ( page ) {
					if ( page.missing || page.invalid ) {
						self.missing[ page.title ] = true;
						self.wikitext[ page.title ] = '';
						return;
					}
					self.missing[ page.title ] = false;
					self.wikitext[ page.title ] =
						( page.revisions && page.revisions[ 0 ].slots.main.content ) || '';
					self.categories[ page.title ] = ( page.categories || [] ).map( function ( c ) {
						return c.title.replace( /^[^:]+:/, '' );
					} );
				} );
				// map the caller's names to normalized titles
				( res.query.normalized || [] ).forEach( function ( n ) {
					if ( !( n.from in self.wikitext ) && ( n.to in self.wikitext ) ) {
						self.wikitext[ n.from ] = self.wikitext[ n.to ];
					}
				} );
			}, function ( code ) {
				throw apiError( code );
			} );
		} ) );
	};

	/** Find which of the seen categories are marked as types, and their colors. */
	WikiStore.prototype._fetchTypeCategories = function () {
		var self = this;
		var names = {};
		Object.keys( this.categories ).forEach( function ( title ) {
			self.categories[ title ].forEach( function ( c ) {
				names[ c ] = true;
			} );
		} );
		var list = Object.keys( names );
		if ( !list.length ) {
			return Promise.resolve();
		}
		return Promise.all( chunk( list, 50 ).map( function ( batch ) {
			return self.api.get( {
				action: 'query',
				titles: batch.map( function ( n ) {
					return 'Category:' + n;
				} ),
				prop: 'pageprops',
				ppprop: 'inferencetype',
				formatversion: 2
			} ).then( function ( res ) {
				( res.query.pages || [] ).forEach( function ( page ) {
					if ( page.pageprops && 'inferencetype' in page.pageprops ) {
						var name = page.title.replace( /^[^:]+:/, '' );
						self.typeColors[ name ] =
							page.pageprops.inferencetype || Text.hashColor( name );
					}
				} );
			} );
		} ) );
	};

	WikiStore.prototype._typeOf = function ( title ) {
		var cats = this.categories[ title ] || [];
		for ( var i = 0; i < cats.length; i++ ) {
			if ( cats[ i ] in this.typeColors ) {
				return cats[ i ];
			}
		}
		return null;
	};

	WikiStore.prototype._thingFor = function ( title, index ) {
		var layout = this.viewDoc.things[ title ];
		var pos = layout || this._autoPlace( index );
		var type = this._typeOf( title );
		return {
			name: title,
			color: type ? this.typeColor( type ) : '#8d8d8d',
			type: type,
			x: pos.x,
			y: pos.y,
			pinned: !!( layout && layout.pinned ),
			missing: !!this.missing[ title ]
		};
	};

	WikiStore.prototype._autoPlace = function ( index ) {
		// golden-angle spiral for pages that have never been laid out
		var angle = index * 2.399963;
		var radius = 110 * Math.sqrt( index + 1 );
		return { x: Math.cos( angle ) * radius, y: Math.sin( angle ) * radius };
	};

	WikiStore.prototype._buildDoc = function ( memberTitles ) {
		var self = this;
		var doc = {
			view: {
				x: this.viewDoc.view.x,
				y: this.viewDoc.view.y,
				zoom: this.viewDoc.view.zoom
			},
			things: {},
			relationships: {}
		};
		var unplaced = 0;
		memberTitles.sort().forEach( function ( title ) {
			doc.things[ title ] = self._thingFor( title,
				self.viewDoc.things[ title ] ? 0 : unplaced++ );
		} );

		// edges from member pages (ghosts contribute their edges too so
		// meta-edges between neighbours resolve; harmless otherwise)
		var candidates = {};
		var tagSet = {};
		memberTitles.forEach( function ( title ) {
			if ( self.missing[ title ] ) {
				return;
			}
			Text.parse( self.wikitext[ title ] || '' ).forEach( function ( entry ) {
				var id = title + '#' + entry.id;
				var resolve = function ( ref ) {
					if ( !ref ) {
						return title;
					}
					return ref[ 0 ] === '#' ? title + ref : ref;
				};
				candidates[ id ] = {
					from: resolve( entry.from ),
					to: resolve( entry.to ),
					tag: entry.tag,
					inferred: entry.inferred,
					evidence: entry.evidence
				};
				if ( entry.tag ) {
					tagSet[ entry.tag ] = true;
				}
			} );
		} );
		// keep an edge once both endpoints resolve (thing or kept edge);
		// drops cycles, self-references and dangling refs
		var kept = {};
		var changed = true;
		while ( changed ) {
			changed = false;
			Object.keys( candidates ).forEach( function ( id ) {
				if ( kept[ id ] ) {
					return;
				}
				var c = candidates[ id ];
				if ( c.from !== c.to &&
					( doc.things[ c.from ] || kept[ c.from ] ) &&
					( doc.things[ c.to ] || kept[ c.to ] ) ) {
					kept[ id ] = true;
					changed = true;
				}
			} );
		}
		Object.keys( kept ).forEach( function ( id ) {
			var c = candidates[ id ];
			var layout = self.viewDoc.edges[ id ] || {};
			doc.relationships[ id ] = {
				from: c.from,
				to: c.to,
				tag: c.tag,
				tagColor: Text.hashColor( c.tag ),
				inferred: c.inferred,
				evidence: c.evidence,
				hx: Number( layout.hx ) || 0,
				hy: Number( layout.hy ) || 0,
				hset: !!layout.hset,
				pinned: !!layout.pinned
			};
		} );
		this.tags = Object.keys( tagSet );
		return doc;
	};

	// ---- persistence helpers ---------------------------------------------------

	WikiStore.prototype._editPage = function ( title, text, summary ) {
		var self = this;
		return this.api.postWithEditToken( {
			action: 'edit',
			title: title,
			text: text,
			summary: summary + ' ([[' + this.viewTitle + '|diagram]])'
		} ).then( function () {
			self.wikitext[ title ] = text;
			self.missing[ title ] = false;
		}, function ( code ) {
			throw apiError( code );
		} );
	};

	/** Persist membership + layout to the Diagram view page. */
	WikiStore.prototype.saveLayout = function ( summary ) {
		var self = this;
		var doc = this.doc;
		this.viewDoc.view = {
			x: Math.round( doc.view.x * 100 ) / 100,
			y: Math.round( doc.view.y * 100 ) / 100,
			zoom: Math.round( doc.view.zoom * 1000 ) / 1000
		};
		this.viewDoc.things = {};
		Object.keys( doc.things ).forEach( function ( title ) {
			if ( title[ 0 ] === ' ' ) {
				return; // pending placeholder
			}
			var t = doc.things[ title ];
			self.viewDoc.things[ title ] = {
				x: Math.round( t.x * 100 ) / 100,
				y: Math.round( t.y * 100 ) / 100,
				pinned: !!t.pinned
			};
		} );
		this.viewDoc.edges = {};
		Object.keys( doc.relationships ).forEach( function ( id ) {
			var rel = doc.relationships[ id ];
			if ( rel.hset || rel.pinned ) {
				self.viewDoc.edges[ id ] = {
					hx: Math.round( rel.hx * 100 ) / 100,
					hy: Math.round( rel.hy * 100 ) / 100,
					hset: !!rel.hset,
					pinned: !!rel.pinned
				};
			}
		} );
		return this.api.postWithEditToken( {
			action: 'edit',
			title: this.viewTitle,
			text: JSON.stringify( this.viewDoc, null, '\t' ),
			summary: summary || 'Update diagram layout'
		} ).then( function () {}, function ( code ) {
			throw apiError( code );
		} );
	};

	// ---- mutations ----------------------------------------------------------------

	WikiStore.prototype.createThing = function ( title, pos ) {
		var self = this;
		title = title.replace( /_/g, ' ' ).trim();
		return this.api.postWithEditToken( {
			action: 'edit',
			title: title,
			text: '',
			summary: 'Create page from diagram [[' + this.viewTitle + ']]',
			createonly: 1
		} ).then( function ( res ) {
			return ( res.edit && res.edit.title ) || title;
		}, function ( code ) {
			if ( code === 'articleexists' ) {
				return title; // fine: just bring the existing page into the view
			}
			throw apiError( code );
		} ).then( function ( finalTitle ) {
			delete self.wikitext[ finalTitle ];
			delete self.missing[ finalTitle ];
			return self._fetchPages( [ finalTitle ] ).then( function () {
				return self._fetchTypeCategories();
			} ).then( function () {
				if ( self.viewDoc.pages.indexOf( finalTitle ) === -1 ) {
					self.viewDoc.pages.push( finalTitle );
				}
				self.viewDoc.things[ finalTitle ] = { x: pos.x, y: pos.y, pinned: false };
				var thing = self._thingFor( finalTitle, 0 );
				thing.x = pos.x;
				thing.y = pos.y;
				self.doc.things[ finalTitle ] = thing;
				// bring in any inferences the existing page already carries
				self._mergeEdgesOf( finalTitle );
				return self.saveLayout( 'Add "' + finalTitle + '" to the diagram' )
					.then( function () {
						return finalTitle;
					} );
			} );
		} );
	};

	/** Add edges parsed from one page's wikitext into the live doc. */
	WikiStore.prototype._mergeEdgesOf = function ( title ) {
		var self = this;
		if ( this.missing[ title ] ) {
			return;
		}
		Text.parse( this.wikitext[ title ] || '' ).forEach( function ( entry ) {
			var id = title + '#' + entry.id;
			var resolve = function ( ref ) {
				if ( !ref ) {
					return title;
				}
				return ref[ 0 ] === '#' ? title + ref : ref;
			};
			var from = resolve( entry.from );
			var to = resolve( entry.to );
			if ( self.doc.relationships[ id ] || from === to ) {
				return;
			}
			if ( !( self.doc.things[ from ] || self.doc.relationships[ from ] ) ||
				!( self.doc.things[ to ] || self.doc.relationships[ to ] ) ) {
				return;
			}
			self.doc.relationships[ id ] = {
				from: from,
				to: to,
				tag: entry.tag,
				tagColor: Text.hashColor( entry.tag ),
				inferred: entry.inferred,
				evidence: entry.evidence,
				hx: 0,
				hy: 0,
				hset: false,
				pinned: false
			};
			if ( entry.tag && self.tags.indexOf( entry.tag ) === -1 ) {
				self.tags.push( entry.tag );
			}
		} );
	};

	WikiStore.prototype.renameThing = function ( oldTitle, newTitle ) {
		var self = this;
		newTitle = newTitle.replace( /_/g, ' ' ).trim();
		return this.api.postWithEditToken( {
			action: 'move',
			from: oldTitle,
			to: newTitle,
			movetalk: 1,
			reason: 'Renamed from diagram [[' + this.viewTitle + ']]'
		} ).then( function () {
			self.wikitext[ newTitle ] = self.wikitext[ oldTitle ] || '';
			self.missing[ newTitle ] = false;
			self.categories[ newTitle ] = self.categories[ oldTitle ] || [];
			delete self.wikitext[ oldTitle ];
			delete self.missing[ oldTitle ];
			delete self.categories[ oldTitle ];

			// rewrite inference references on the pages we know about
			var updates = [];
			Object.keys( self.wikitext ).forEach( function ( title ) {
				var rewritten = Text.renameReferences( self.wikitext[ title ], oldTitle, newTitle );
				if ( rewritten !== null ) {
					updates.push( self._editPage( title, rewritten,
						'Update inferences after "' + oldTitle + '" → "' + newTitle + '"' ) );
				}
			} );
			return Promise.all( updates );
		}, function ( code ) {
			throw apiError( code );
		} ).then( function () {
			// remap view + doc
			var pageIdx = self.viewDoc.pages.indexOf( oldTitle );
			if ( pageIdx !== -1 ) {
				self.viewDoc.pages[ pageIdx ] = newTitle;
			}
			if ( self.viewDoc.things[ oldTitle ] ) {
				self.viewDoc.things[ newTitle ] = self.viewDoc.things[ oldTitle ];
				delete self.viewDoc.things[ oldTitle ];
			}
			var doc = self.doc;
			doc.things[ newTitle ] = doc.things[ oldTitle ];
			doc.things[ newTitle ].name = newTitle;
			delete doc.things[ oldTitle ];
			if ( self.graph ) {
				self.graph.remapId( 'thing', oldTitle, newTitle );
			}
			var renameRef = function ( ref ) {
				if ( ref === oldTitle ) {
					return newTitle;
				}
				if ( ref.indexOf( oldTitle + '#' ) === 0 ) {
					return newTitle + ref.slice( oldTitle.length );
				}
				return ref;
			};
			Object.keys( doc.relationships ).forEach( function ( id ) {
				var rel = doc.relationships[ id ];
				rel.from = renameRef( rel.from );
				rel.to = renameRef( rel.to );
				var newId = renameRef( id );
				if ( newId !== id ) {
					doc.relationships[ newId ] = rel;
					delete doc.relationships[ id ];
					if ( self.viewDoc.edges[ id ] ) {
						self.viewDoc.edges[ newId ] = self.viewDoc.edges[ id ];
						delete self.viewDoc.edges[ id ];
					}
					if ( self.graph ) {
						self.graph.remapId( 'rel', id, newId );
					}
				}
			} );
			return self.saveLayout( 'Rename "' + oldTitle + '" to "' + newTitle + '"' );
		} ).then( function () {
			return newTitle;
		} );
	};

	WikiStore.prototype.removeThing = function ( title ) {
		var self = this;
		var idx = this.viewDoc.pages.indexOf( title );
		var hasLayout = !!this.viewDoc.things[ title ];
		var isGhost = this._ghosts && this._ghosts[ title ];
		if ( idx === -1 && !hasLayout && !isGhost ) {
			return Promise.reject( new Error( this.viewDoc.allPages ?
				'This view shows all pages, so "' + title + '" cannot be removed from it.' :
				'"' + title + '" is included by Category:' + this.viewDoc.category +
				'. Remove that category from the page to take it out of this view.' ) );
		}
		if ( idx !== -1 ) {
			this.viewDoc.pages.splice( idx, 1 );
		}
		delete this.viewDoc.things[ title ];
		delete this.doc.things[ title ];
		// drop edges that lost an endpoint (view only; the wikitext keeps them)
		var dead = {};
		dead[ title ] = true;
		var changed = true;
		while ( changed ) {
			changed = false;
			Object.keys( this.doc.relationships ).forEach( function ( id ) {
				var rel = self.doc.relationships[ id ];
				if ( dead[ rel.from ] || dead[ rel.to ] ) {
					delete self.doc.relationships[ id ];
					dead[ id ] = true;
					changed = true;
				}
			} );
		}
		return this.saveLayout( 'Remove "' + title + '" from the diagram' );
	};

	/** Compose the wikitext reference for an endpoint as seen from sourcePage. */
	WikiStore.prototype._refFor = function ( id, sourcePage ) {
		var hash = id.indexOf( '#' );
		if ( hash === -1 ) {
			return id === sourcePage ? '' : id;
		}
		return id.slice( 0, hash ) === sourcePage ? id.slice( hash ) : id;
	};

	WikiStore.prototype.addEdge = function ( fromId, toId, tag ) {
		var self = this;
		var sourcePage = fromId.split( '#' )[ 0 ];
		var text = this.wikitext[ sourcePage ];
		if ( text === undefined || this.missing[ sourcePage ] === true ) {
			return Promise.reject( new Error(
				'Cannot store a relationship on missing page "' + sourcePage + '" — create it first.' ) );
		}
		var localId = Text.nextId( text );
		var entry = {
			id: localId,
			from: this._refFor( fromId, sourcePage ),
			to: this._refFor( toId, sourcePage ),
			tag: tag || '',
			inferred: false,
			evidence: []
		};
		var newText = Text.upsert( text, entry );
		return this._editPage( sourcePage, newText,
			'Add inference to [[' + toId.split( '#' )[ 0 ] + ']]' +
			( tag ? ' (' + tag + ')' : '' )
		).then( function () {
			var id = sourcePage + '#' + localId;
			self.doc.relationships[ id ] = {
				from: fromId,
				to: toId,
				tag: tag || '',
				tagColor: Text.hashColor( tag || '' ),
				inferred: false,
				evidence: [],
				hx: 0,
				hy: 0,
				hset: false,
				pinned: false
			};
			if ( tag && self.tags.indexOf( tag ) === -1 ) {
				self.tags.push( tag );
			}
			return id;
		} );
	};

	WikiStore.prototype.updateEdge = function ( id, changes ) {
		var self = this;
		var hash = id.indexOf( '#' );
		var sourcePage = id.slice( 0, hash );
		var localId = id.slice( hash + 1 );
		var rel = this.doc.relationships[ id ];
		var text = this.wikitext[ sourcePage ];
		if ( !rel || text === undefined ) {
			return Promise.reject( new Error( 'Unknown relationship ' + id ) );
		}
		var entry = {
			id: localId,
			from: this._refFor( rel.from, sourcePage ),
			to: this._refFor( rel.to, sourcePage ),
			tag: 'tag' in changes ? changes.tag : rel.tag,
			inferred: 'inferred' in changes ? changes.inferred : rel.inferred,
			evidence: 'evidence' in changes ? changes.evidence : rel.evidence
		};
		var newText = Text.upsert( text, entry );
		return this._editPage( sourcePage, newText, 'Update inference §' + localId )
			.then( function () {
				rel.tag = entry.tag;
				rel.tagColor = Text.hashColor( entry.tag );
				rel.inferred = entry.inferred;
				rel.evidence = entry.evidence;
				if ( entry.tag && self.tags.indexOf( entry.tag ) === -1 ) {
					self.tags.push( entry.tag );
				}
			} );
	};

	WikiStore.prototype.removeEdge = function ( id ) {
		var self = this;
		// removing an edge also removes edges anchored on it, recursively
		var order = [];
		( function collect( target ) {
			Object.keys( self.doc.relationships ).forEach( function ( otherId ) {
				var rel = self.doc.relationships[ otherId ];
				if ( ( rel.from === target || rel.to === target ) &&
					order.indexOf( otherId ) === -1 ) {
					collect( otherId );
					order.push( otherId );
				}
			} );
		}( id ) );
		order.push( id );

		return order.reduce( function ( prev, edgeId ) {
			return prev.then( function () {
				var hash = edgeId.indexOf( '#' );
				var sourcePage = edgeId.slice( 0, hash );
				var text = self.wikitext[ sourcePage ];
				if ( text === undefined ) {
					return;
				}
				var newText = Text.remove( text, edgeId.slice( hash + 1 ) );
				if ( newText === text ) {
					delete self.doc.relationships[ edgeId ];
					return;
				}
				return self._editPage( sourcePage, newText,
					'Remove inference §' + edgeId.slice( hash + 1 ) ).then( function () {
					delete self.doc.relationships[ edgeId ];
					delete self.viewDoc.edges[ edgeId ];
				} );
			} );
		}, Promise.resolve() );
	};

	WikiStore.prototype.setType = function ( title, typeName ) {
		var self = this;
		var thing = this.doc.things[ title ];
		var text = this.wikitext[ title ];
		if ( !thing || text === undefined ) {
			return Promise.reject( new Error( 'Unknown page ' + title ) );
		}
		var ensureCategory = ( typeName && !( typeName in this.typeColors ) ) ?
			this.api.postWithEditToken( {
				action: 'edit',
				title: 'Category:' + typeName,
				text: '{{#inferencetype:color=' + Text.hashColor( typeName ) + '}}\n',
				summary: 'Mark category as an Inferences thing type',
				createonly: 1
			} ).then( function () {}, function ( code ) {
				if ( code !== 'articleexists' ) {
					throw apiError( code );
				}
			} ).then( function () {
				self.typeColors[ typeName ] = Text.hashColor( typeName );
			} ) :
			Promise.resolve();

		return Promise.resolve( ensureCategory ).then( function () {
			var newText = Text.replaceCategory( text, thing.type, typeName );
			if ( newText === text ) {
				return;
			}
			return self._editPage( title, newText,
				typeName ? 'Set type to ' + typeName : 'Remove type' );
		} ).then( function () {
			thing.type = typeName || null;
			thing.color = typeName ? self.typeColor( typeName ) : '#8d8d8d';
			var cats = self.categories[ title ] || [];
			var without = cats.filter( function ( c ) {
				return c !== thing.type && !( c in self.typeColors );
			} );
			self.categories[ title ] = typeName ? without.concat( [ typeName ] ) : without;
		} );
	};

	module.exports = WikiStore;
}() );
