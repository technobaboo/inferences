/**
 * Inferences canvas — a graph VIEW over a wiki, not a document editor.
 *
 * Things are wiki pages, relationships are {{#inference:…}} calls in
 * those pages' wikitext, types are categories. All semantic edits are
 * delegated to a pluggable async store (WikiStore against MediaWiki,
 * a mock in the dev harness) and become real page edits immediately;
 * only layout (positions, curve handles, pins, pan/zoom) belongs to the
 * view itself and is saved separately.
 *
 * Interactions (edit mode):
 *   right-click empty space ... add a thing (creates the page)
 *   right-drag from a thing .. connect it (writes an inference into the
 *                              source page; release on empty space to
 *                              create and connect a new page)
 *   left-drag a thing ........ move it (layout)
 *   left/middle-drag empty ... pan;  wheel ............... zoom
 *   click thing/edge ......... open inspector card (pin to keep open)
 *   drag the diamond ......... reshape a selected edge (layout)
 *   Delete ................... remove selection (edge: real edit;
 *                              thing: removed from the view)
 *
 * The store interface (all mutators return thenables and patch
 * graph.doc themselves before resolving):
 *   knownTags() / knownTypes()          -> string[]
 *   tagColor( name )                    -> '#rrggbb'
 *   createThing( title, pos )           -> resolves new id
 *   renameThing( id, newTitle )         -> resolves new id
 *   removeThing( id )
 *   addEdge( fromId, toId, tag )        -> resolves new edge id
 *   updateEdge( id, changes )
 *   removeEdge( id )
 *   setType( id, typeName|null )
 *
 * Exported as `module.exports` (ResourceLoader / CommonJS) and as
 * `window.InferencesGraph` (dev harness).
 */
( function ( root, factory ) {
	if ( typeof module !== 'undefined' && module.exports ) {
		module.exports = factory();
	} else {
		root.InferencesGraph = factory();
	}
}( typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	var THING_RADIUS = 32;
	var REL_ANCHOR_RADIUS = 12; // rim radius when an edge is the endpoint
	var CLICK_SLOP = 4;
	var RIGHT_DEADZONE = 10; // matches the native app's radial deadzone
	var MIN_ZOOM = 0.2;
	var MAX_ZOOM = 2.5;
	// impossible page title (titles can't start with a space)
	var PENDING = ' pending';

	function clamp( v, lo, hi ) {
		return v < lo ? lo : ( v > hi ? hi : v );
	}

	function el( tag, className, parent ) {
		var node = document.createElement( tag );
		if ( className ) {
			node.className = className;
		}
		if ( parent ) {
			parent.appendChild( node );
		}
		return node;
	}

	function isFormField( target ) {
		return target && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test( target.tagName );
	}

	/**
	 * @param {HTMLElement} container
	 * @param {Object} options
	 * @param {Object} options.store semantic backend (see file docblock)
	 * @param {Object} options.doc initial {view, things, relationships}
	 * @param {boolean} [options.editable=false]
	 * @param {Function} [options.onDirtyChange] called with (layoutDirty)
	 * @param {Function} [options.resolveHref] title -> url (or null)
	 * @param {Function} [options.navigate] called with (title) on view-mode node click
	 * @param {Function} [options.isDark] page theme probe; default prefers-color-scheme
	 * @param {Object} [options.pageApi] optional { load(title), save(title, text) }
	 * @param {Function} [options.renderPage] title -> Promise<html>; when set,
	 *   a relationship card shows the source article's rendered text in a
	 *   resizable panel (auto-opened in view mode)
	 * @param {Function} [options.notify] called with (message, isError)
	 */
	function Graph( container, options ) {
		options = options || {};
		this.container = container;
		this.store = options.store;
		this.editable = !!options.editable;
		this.onDirtyChange = options.onDirtyChange || function () {};
		this.resolveHref = options.resolveHref || function () { return null; };
		this.navigate = options.navigate || function () {};
		this.pageApi = options.pageApi || null;
		this.renderPage = options.renderPage || null;
		this.notify = options.notify || function () {};
		this.isDark = options.isDark || function () {
			return window.matchMedia &&
				window.matchMedia( '(prefers-color-scheme: dark)' ).matches;
		};
		this.doc = options.doc || { view: { x: 0, y: 0, zoom: 1 }, things: {}, relationships: {} };

		this.layoutDirty = false;
		this.selection = null; // { kind: 'thing'|'rel', id }
		this.hover = null;
		this.drag = null;
		this.pendingEdge = null; // { from, to } while the tag chooser is open
		this.cards = {};
		this.tagChooser = null;

		this._buildDom();
		this._applyThemeClass();
		this._bindEvents();
		this._openPinnedCards();
		this.zoomToFit( true );
		this._scheduleRender();
	}

	// ---- theming ----------------------------------------------------------

	Graph.prototype._applyThemeClass = function () {
		var dark = !!this.isDark();
		this.container.classList.toggle( 'inf-theme-dark', dark );
		this.container.classList.toggle( 'inf-theme-light', !dark );
		this._themeCache = null;
	};

	Graph.prototype.refreshTheme = function () {
		this._applyThemeClass();
		this._scheduleRender();
	};

	Graph.prototype._theme = function () {
		if ( !this._themeCache ) {
			var cs = getComputedStyle( this.container );
			var v = function ( name, fallback ) {
				var value = cs.getPropertyValue( name ).trim();
				return value || fallback;
			};
			this._themeCache = {
				bg: v( '--inf-bg', '#1b1b1f' ),
				gridRgb: v( '--inf-grid-rgb', '128, 128, 128' ),
				nodeFill: v( '--inf-node-fill', '#26262b' ),
				text: v( '--inf-text', '#e6e6e6' ),
				muted: v( '--inf-muted', '#9a9aa2' ),
				link: v( '--inf-link', '#9ab4ff' ),
				danger: v( '--inf-danger', '#ff9498' ),
				ghostRgb: v( '--inf-ghost-rgb', '255, 255, 255' )
			};
		}
		return this._themeCache;
	};

	// ---- dom --------------------------------------------------------------

	Graph.prototype._buildDom = function () {
		this.container.classList.add( 'inf-graph' );
		this.canvas = el( 'canvas', 'inf-canvas', this.container );
		this.overlay = el( 'div', 'inf-overlay', this.container );
		this.toolbar = el( 'div', 'inf-toolbar', this.container );

		var self = this;
		this.addToolbarButton( '⤢ Fit', function () {
			self.zoomToFit();
		} );
		this.hintEl = el( 'span', 'inf-hint', this.toolbar );
		this._updateHint();

		this._resizeObserver = new ResizeObserver( function () {
			self._resizeCanvas();
		} );
		this._resizeObserver.observe( this.container );
		this._resizeCanvas();
	};

	Graph.prototype.addToolbarButton = function ( label, onClick, opts ) {
		var btn = el( 'button', 'inf-btn' + ( opts && opts.primary ? ' inf-btn-primary' : '' ), this.toolbar );
		btn.type = 'button';
		btn.textContent = label;
		btn.addEventListener( 'click', onClick );
		return btn;
	};

	Graph.prototype._updateHint = function () {
		this.hintEl.textContent = this.editable ?
			'right-click: add page · right-drag from a thing: connect · edits apply to the pages immediately' :
			'drag: pan · wheel: zoom · click a thing to open its page';
	};

	Graph.prototype._resizeCanvas = function () {
		var dpr = window.devicePixelRatio || 1;
		var w = this.container.clientWidth;
		var h = this.container.clientHeight;
		if ( w === 0 || h === 0 ) {
			return;
		}
		this.canvas.width = Math.round( w * dpr );
		this.canvas.height = Math.round( h * dpr );
		this._scheduleRender();
	};

	// ---- coordinate transforms ---------------------------------------------

	Graph.prototype._w2s = function ( x, y ) {
		var v = this.doc.view;
		return {
			x: ( x - v.x ) * v.zoom + this.container.clientWidth / 2,
			y: ( y - v.y ) * v.zoom + this.container.clientHeight / 2
		};
	};

	Graph.prototype._s2w = function ( x, y ) {
		var v = this.doc.view;
		return {
			x: ( x - this.container.clientWidth / 2 ) / v.zoom + v.x,
			y: ( y - this.container.clientHeight / 2 ) / v.zoom + v.y
		};
	};

	Graph.prototype._eventPos = function ( e ) {
		var rect = this.canvas.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	};

	// ---- hit testing --------------------------------------------------------

	Graph.prototype._thingAt = function ( wpt ) {
		var ids = Object.keys( this.doc.things );
		for ( var i = ids.length - 1; i >= 0; i-- ) {
			var t = this.doc.things[ ids[ i ] ];
			var dx = wpt.x - t.x;
			var dy = wpt.y - t.y;
			if ( dx * dx + dy * dy <= THING_RADIUS * THING_RADIUS ) {
				return ids[ i ];
			}
		}
		return null;
	};

	Graph.prototype._anchorOf = function ( id, visited ) {
		var t = this.doc.things[ id ];
		if ( t ) {
			return { x: t.x, y: t.y, r: THING_RADIUS };
		}
		var rel = this.doc.relationships[ id ];
		if ( !rel ) {
			return { x: 0, y: 0, r: 0 };
		}
		visited = visited || {};
		if ( visited[ id ] ) {
			return { x: rel.hx, y: rel.hy, r: REL_ANCHOR_RADIUS };
		}
		visited[ id ] = true;
		var p = this._bezierPoint( rel, 0.5, visited );
		p.r = REL_ANCHOR_RADIUS;
		return p;
	};

	Graph.prototype._relHandle = function ( rel, visited ) {
		if ( rel.hset ) {
			return { x: rel.hx, y: rel.hy };
		}
		var a = this._anchorOf( rel.from, visited );
		var b = this._anchorOf( rel.to, visited );
		return { x: ( a.x + b.x ) / 2, y: ( a.y + b.y ) / 2 };
	};

	Graph.prototype._bezierPoint = function ( rel, t, visited ) {
		visited = visited || {};
		var a = this._anchorOf( rel.from, visited );
		var b = this._anchorOf( rel.to, visited );
		// Derive the handle from the anchors we just resolved rather than
		// re-resolving them through _relHandle: resolving rel.to has already
		// marked it in `visited`, so a second resolution would hit the
		// cycle-guard fallback and return a bogus handle for meta-edges.
		var h = rel.hset ?
			{ x: rel.hx, y: rel.hy } :
			{ x: ( a.x + b.x ) / 2, y: ( a.y + b.y ) / 2 };
		// Evaluate along the curve as it is actually drawn: from each
		// endpoint's rim (not its centre) toward the handle. Keeping this in
		// sync with _drawRelationships is what makes labels, meta-edge
		// anchors and hit-testing land on the visible line even when the
		// control point is dragged or an endpoint is another relationship.
		var start = trimToRim( a, h.x, h.y );
		var end = trimToRim( b, h.x, h.y );
		var mt = 1 - t;
		return {
			x: mt * mt * start.x + 2 * mt * t * h.x + t * t * end.x,
			y: mt * mt * start.y + 2 * mt * t * h.y + t * t * end.y
		};
	};

	Graph.prototype._relAt = function ( wpt ) {
		var tolerance = 8 / this.doc.view.zoom;
		var best = null;
		var bestDist = tolerance;
		var self = this;
		Object.keys( this.doc.relationships ).forEach( function ( id ) {
			var rel = self.doc.relationships[ id ];
			for ( var i = 0; i <= 24; i++ ) {
				var p = self._bezierPoint( rel, i / 24 );
				var d = Math.hypot( wpt.x - p.x, wpt.y - p.y );
				if ( d < bestDist ) {
					bestDist = d;
					best = id;
				}
			}
		} );
		return best;
	};

	Graph.prototype._handleAt = function ( wpt ) {
		if ( !this.selection || this.selection.kind !== 'rel' ) {
			return null;
		}
		var rel = this.doc.relationships[ this.selection.id ];
		if ( !rel ) {
			return null;
		}
		var h = this._relHandle( rel );
		var r = 10 / this.doc.view.zoom;
		if ( Math.hypot( wpt.x - h.x, wpt.y - h.y ) <= r ) {
			return this.selection.id;
		}
		return null;
	};

	// ---- store plumbing -----------------------------------------------------

	/** The store patched this.doc; refresh visuals and open cards. */
	Graph.prototype.docChanged = function () {
		var self = this;
		if ( this.selection && !this._selectionExists() ) {
			this.selection = null;
		}
		Object.keys( this.cards ).forEach( function ( key ) {
			var card = self.cards[ key ];
			var exists = card.kind === 'thing' ?
				self.doc.things[ card.id ] : self.doc.relationships[ card.id ];
			if ( exists ) {
				self._rebuildCard( card );
			} else {
				self._closeCard( key );
			}
		} );
		this._scheduleRender();
	};

	/** A card's object id changed (page rename); keep the card attached. */
	Graph.prototype.remapId = function ( kind, oldId, newId ) {
		var oldKey = kind + ':' + oldId;
		var card = this.cards[ oldKey ];
		if ( card ) {
			delete this.cards[ oldKey ];
			card.id = newId;
			this.cards[ kind + ':' + newId ] = card;
		}
		if ( this.selection && this.selection.kind === kind && this.selection.id === oldId ) {
			this.selection.id = newId;
		}
	};

	Graph.prototype._storeCall = function ( promise, okMessage ) {
		var self = this;
		return Promise.resolve( promise ).then( function ( result ) {
			self.docChanged();
			if ( okMessage ) {
				self.notify( okMessage, false );
			}
			return result;
		}, function ( err ) {
			self.docChanged();
			self.notify( String( ( err && err.message ) || err ), true );
			throw err;
		} );
	};

	Graph.prototype._selectionExists = function () {
		if ( !this.selection ) {
			return false;
		}
		return this.selection.kind === 'thing' ?
			!!this.doc.things[ this.selection.id ] :
			!!this.doc.relationships[ this.selection.id ];
	};

	// ---- layout dirtiness ---------------------------------------------------

	Graph.prototype._markLayoutDirty = function () {
		if ( !this.layoutDirty ) {
			this.layoutDirty = true;
			this.onDirtyChange( true );
		}
		this._scheduleRender();
	};

	Graph.prototype.markLayoutSaved = function () {
		this.layoutDirty = false;
		this.onDirtyChange( false );
	};

	// ---- pending thing creation --------------------------------------------

	Graph.prototype._beginCreateThing = function ( wpt ) {
		if ( this.doc.things[ PENDING ] ) {
			return;
		}
		this.doc.things[ PENDING ] = {
			name: '',
			color: '#8d8d8d',
			type: null,
			x: wpt.x,
			y: wpt.y,
			pinned: false,
			missing: false,
			pending: true
		};
		this._select( 'thing', PENDING );
		this._focusCardField( 'thing:' + PENDING, 'name' );
	};

	Graph.prototype._cancelCreateThing = function () {
		if ( this.doc.things[ PENDING ] ) {
			delete this.doc.things[ PENDING ];
			this._closeCard( 'thing:' + PENDING );
			if ( this.selection && this.selection.id === PENDING ) {
				this.selection = null;
			}
			this._scheduleRender();
		}
	};

	Graph.prototype._commitCreateThing = function ( name, connectFrom ) {
		var self = this;
		var pendingThing = this.doc.things[ PENDING ];
		if ( !pendingThing ) {
			return;
		}
		name = name.trim();
		if ( !name ) {
			this._cancelCreateThing();
			return;
		}
		var pos = { x: pendingThing.x, y: pendingThing.y };
		this._cancelCreateThing();
		this._storeCall( this.store.createThing( name, pos ) )
			.then( function ( newId ) {
				self._select( 'thing', newId );
				if ( connectFrom && ( self.doc.things[ connectFrom ] ||
					self.doc.relationships[ connectFrom ] ) ) {
					self._beginEdge( connectFrom, newId );
				}
			}, function () {} );
	};

	// ---- selection & view ----------------------------------------------------

	Graph.prototype._select = function ( kind, id ) {
		this.selection = kind ? { kind: kind, id: id } : null;
		if ( kind ) {
			this._openCard( kind, id );
		}
		this._closeUnpinnedCardsExcept( kind ? kind + ':' + id : null );
		this._scheduleRender();
	};

	Graph.prototype.zoomToFit = function ( initial ) {
		var ids = Object.keys( this.doc.things );
		if ( !ids.length ) {
			if ( !initial ) {
				this.doc.view.x = 0;
				this.doc.view.y = 0;
				this.doc.view.zoom = 1;
				this._scheduleRender();
			}
			return;
		}
		var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		var self = this;
		ids.forEach( function ( id ) {
			var t = self.doc.things[ id ];
			minX = Math.min( minX, t.x - THING_RADIUS );
			minY = Math.min( minY, t.y - THING_RADIUS );
			maxX = Math.max( maxX, t.x + THING_RADIUS );
			maxY = Math.max( maxY, t.y + THING_RADIUS );
		} );
		var w = this.container.clientWidth || 512;
		var h = this.container.clientHeight || 512;
		var pad = 64;
		var zoom = clamp( Math.min(
			w / ( maxX - minX + pad * 2 ),
			h / ( maxY - minY + pad * 2 )
		), MIN_ZOOM, 1 );
		this.doc.view.x = ( minX + maxX ) / 2;
		this.doc.view.y = ( minY + maxY ) / 2;
		this.doc.view.zoom = zoom;
		this._scheduleRender();
	};

	Graph.prototype.getDoc = function () {
		return this.doc;
	};

	Graph.prototype.setEditable = function ( editable ) {
		this.editable = !!editable;
		this._cancelTagChooser();
		this._cancelCreateThing();
		this._closeAllCards();
		this._openPinnedCards();
		this.selection = null;
		this._updateHint();
		this._scheduleRender();
	};

	Graph.prototype.destroy = function () {
		this._resizeObserver.disconnect();
		if ( this._mq && this._mq.removeEventListener ) {
			this._mq.removeEventListener( 'change', this._mqListener );
		}
		this.container.textContent = '';
		this.container.classList.remove( 'inf-graph', 'inf-theme-dark', 'inf-theme-light' );
	};

	// ---- events ---------------------------------------------------------------

	Graph.prototype._bindEvents = function () {
		var self = this;
		var c = this.canvas;

		c.addEventListener( 'contextmenu', function ( e ) {
			e.preventDefault();
		} );

		c.addEventListener( 'wheel', function ( e ) {
			e.preventDefault();
			var pos = self._eventPos( e );
			var before = self._s2w( pos.x, pos.y );
			var v = self.doc.view;
			v.zoom = clamp( v.zoom * Math.exp( -e.deltaY * 0.0015 ), MIN_ZOOM, MAX_ZOOM );
			var after = self._s2w( pos.x, pos.y );
			v.x += before.x - after.x;
			v.y += before.y - after.y;
			self._scheduleRender();
		}, { passive: false } );

		c.addEventListener( 'pointerdown', function ( e ) {
			self._onPointerDown( e );
		} );
		c.addEventListener( 'pointermove', function ( e ) {
			self._onPointerMove( e );
		} );
		c.addEventListener( 'pointerup', function ( e ) {
			self._onPointerUp( e );
		} );
		c.addEventListener( 'pointercancel', function () {
			self.drag = null;
			self._scheduleRender();
		} );

		this.container.tabIndex = 0;
		this.container.addEventListener( 'keydown', function ( e ) {
			self._onKeyDown( e );
		} );

		if ( window.matchMedia ) {
			this._mq = window.matchMedia( '(prefers-color-scheme: dark)' );
			this._mqListener = function () {
				self.refreshTheme();
			};
			if ( this._mq.addEventListener ) {
				this._mq.addEventListener( 'change', this._mqListener );
			}
		}
	};

	Graph.prototype._onPointerDown = function ( e ) {
		if ( this.tagChooser ) {
			return;
		}
		var pos = this._eventPos( e );
		var wpt = this._s2w( pos.x, pos.y );
		this.canvas.setPointerCapture( e.pointerId );
		this.container.focus( { preventScroll: true } );

		var start = {
			pointerId: e.pointerId,
			button: e.button,
			startScreen: pos,
			lastScreen: pos,
			startWorld: wpt,
			moved: false
		};

		if ( e.button === 1 ) {
			start.mode = 'pan';
		} else if ( e.button === 0 ) {
			var handle = this.editable && this._handleAt( wpt );
			var thing = this._thingAt( wpt );
			var rel = thing ? null : this._relAt( wpt );
			if ( handle ) {
				start.mode = 'handle';
				start.id = handle;
			} else if ( thing && this.editable ) {
				start.mode = 'thing';
				start.id = thing;
				var t = this.doc.things[ thing ];
				start.grabOffset = { x: t.x - wpt.x, y: t.y - wpt.y };
			} else if ( thing ) {
				start.mode = 'clickThing';
				start.id = thing;
			} else if ( rel ) {
				start.mode = 'clickRel';
				start.id = rel;
			} else {
				start.mode = 'pan';
				start.deselectOnClick = true;
			}
		} else if ( e.button === 2 ) {
			var overThing = this._thingAt( wpt );
			var overRel = overThing ? null : this._relAt( wpt );
			if ( this.editable && ( overThing || overRel ) && overThing !== PENDING ) {
				start.mode = 'connect';
				start.id = overThing || overRel;
			} else if ( this.editable ) {
				start.mode = 'rightAdd';
			} else {
				start.mode = 'pan';
			}
		} else {
			return;
		}
		this.drag = start;
	};

	Graph.prototype._onPointerMove = function ( e ) {
		var pos = this._eventPos( e );
		var wpt = this._s2w( pos.x, pos.y );

		if ( !this.drag ) {
			var thing = this._thingAt( wpt );
			this.hover = thing ? { kind: 'thing', id: thing } : null;
			if ( !thing ) {
				var rel = this._relAt( wpt );
				if ( rel ) {
					this.hover = { kind: 'rel', id: rel };
				}
			}
			this.canvas.style.cursor = ( !this.editable && thing ) ? 'pointer' : ( thing ? 'grab' : '' );
			this._scheduleRender();
			return;
		}

		var d = this.drag;
		if ( d.pointerId !== e.pointerId ) {
			return;
		}
		var slop = d.button === 2 ? RIGHT_DEADZONE : CLICK_SLOP;
		if ( Math.hypot( pos.x - d.startScreen.x, pos.y - d.startScreen.y ) > slop ) {
			d.moved = true;
		}

		if ( d.mode === 'pan' || ( d.mode === 'rightAdd' && d.moved ) ) {
			var v = this.doc.view;
			v.x -= ( pos.x - d.lastScreen.x ) / v.zoom;
			v.y -= ( pos.y - d.lastScreen.y ) / v.zoom;
			this.canvas.style.cursor = 'grabbing';
		} else if ( d.mode === 'thing' && d.moved ) {
			var t = this.doc.things[ d.id ];
			t.x = wpt.x + d.grabOffset.x;
			t.y = wpt.y + d.grabOffset.y;
			if ( !t.pending ) {
				this._markLayoutDirty();
			}
		} else if ( d.mode === 'handle' && d.moved ) {
			var rel2 = this.doc.relationships[ d.id ];
			rel2.hx = wpt.x;
			rel2.hy = wpt.y;
			rel2.hset = true;
			this._markLayoutDirty();
		} else if ( d.mode === 'connect' ) {
			d.ghostTo = wpt;
		}
		d.lastScreen = pos;
		this._scheduleRender();
	};

	Graph.prototype._onPointerUp = function ( e ) {
		var d = this.drag;
		if ( !d || d.pointerId !== e.pointerId ) {
			return;
		}
		this.drag = null;
		this.canvas.style.cursor = '';
		var pos = this._eventPos( e );
		var wpt = this._s2w( pos.x, pos.y );

		if ( d.mode === 'rightAdd' && !d.moved ) {
			this._beginCreateThing( wpt );
		} else if ( d.mode === 'connect' ) {
			var target = this._thingAt( wpt ) || this._relAt( wpt );
			if ( target === d.id ) {
				this._select( this.doc.things[ d.id ] ? 'thing' : 'rel', d.id );
			} else if ( target && target !== PENDING ) {
				this._beginEdge( d.id, target, pos );
			} else if ( !target ) {
				// create a new page there, then connect to it
				this._beginCreateThing( wpt );
				var card = this.cards[ 'thing:' + PENDING ];
				if ( card ) {
					card.connectFrom = d.id;
				}
			}
		} else if ( d.mode === 'thing' && !d.moved ) {
			this._select( 'thing', d.id );
		} else if ( d.mode === 'clickThing' && !d.moved ) {
			var t = this.doc.things[ d.id ];
			if ( !this.editable && !t.pending ) {
				this.navigate( d.id );
			} else {
				this._select( 'thing', d.id );
			}
		} else if ( d.mode === 'clickRel' && !d.moved ) {
			this._select( 'rel', d.id );
		} else if ( d.deselectOnClick && !d.moved ) {
			this._select( null );
			this._cancelCreateThing();
		}
		this._scheduleRender();
	};

	Graph.prototype._onKeyDown = function ( e ) {
		if ( isFormField( e.target ) ) {
			return;
		}
		if ( !this.editable ) {
			return;
		}
		if ( ( e.key === 'Delete' || e.key === 'Backspace' ) && this.selection ) {
			e.preventDefault();
			var sel = this.selection;
			if ( sel.id === PENDING ) {
				this._cancelCreateThing();
			} else if ( sel.kind === 'thing' ) {
				this._storeCall( this.store.removeThing( sel.id ) );
			} else {
				this._storeCall( this.store.removeEdge( sel.id ) );
			}
		} else if ( e.key === 'Escape' ) {
			this._cancelTagChooser();
			this._cancelCreateThing();
			this._select( null );
		}
	};

	// ---- edges ------------------------------------------------------------------

	Graph.prototype._beginEdge = function ( fromId, toId, screenPos ) {
		this.pendingEdge = { from: fromId, to: toId };
		this._scheduleRender();
		this._openTagChooser( screenPos || this._pendingEdgeScreenMid() );
	};

	Graph.prototype._pendingEdgeScreenMid = function () {
		var a = this._anchorOf( this.pendingEdge.from );
		var b = this._anchorOf( this.pendingEdge.to );
		return this._w2s( ( a.x + b.x ) / 2, ( a.y + b.y ) / 2 );
	};

	Graph.prototype._commitEdge = function ( tag ) {
		var self = this;
		var pending = this.pendingEdge;
		this.pendingEdge = null;
		this._cancelTagChooser();
		if ( !pending ) {
			return;
		}
		this._storeCall( this.store.addEdge( pending.from, pending.to, tag ) )
			.then( function ( id ) {
				self._select( 'rel', id );
			}, function () {} );
	};

	Graph.prototype._openTagChooser = function ( screenPos ) {
		if ( this.tagChooser ) {
			this.tagChooser.el.remove();
			this.tagChooser = null;
		}
		var self = this;
		var box = el( 'div', 'inf-card inf-tag-chooser', this.overlay );
		box.style.left = clamp( screenPos.x, 0, Math.max( 0, this.container.clientWidth - 190 ) ) + 'px';
		box.style.top = clamp( screenPos.y, 0, Math.max( 0, this.container.clientHeight - 180 ) ) + 'px';
		var title = el( 'div', 'inf-card-title', box );
		title.textContent = 'Relationship tag';

		this.store.knownTags().forEach( function ( tagName ) {
			var row = el( 'button', 'inf-tag-option', box );
			row.type = 'button';
			var dot = el( 'span', 'inf-tag-dot', row );
			dot.style.background = self.store.tagColor( tagName );
			row.appendChild( document.createTextNode( tagName ) );
			row.addEventListener( 'click', function () {
				self._commitEdge( tagName );
			} );
		} );

		var form = el( 'div', 'inf-tag-new', box );
		var input = el( 'input', 'inf-input', form );
		input.placeholder = 'new tag…';
		var add = el( 'button', 'inf-btn', form );
		add.type = 'button';
		add.textContent = '+';
		function createTag() {
			var name = input.value.trim();
			if ( name ) {
				self._commitEdge( name );
			}
		}
		add.addEventListener( 'click', createTag );
		input.addEventListener( 'keydown', function ( e ) {
			if ( e.key === 'Enter' ) {
				createTag();
			} else if ( e.key === 'Escape' ) {
				self._cancelTagChooser();
			}
			e.stopPropagation();
		} );

		var skip = el( 'button', 'inf-btn inf-btn-subtle', box );
		skip.type = 'button';
		skip.textContent = 'no tag for now';
		skip.addEventListener( 'click', function () {
			self._commitEdge( '' );
		} );

		this.tagChooser = { el: box };
		input.focus();
	};

	Graph.prototype._cancelTagChooser = function () {
		if ( this.tagChooser ) {
			this.tagChooser.el.remove();
			this.tagChooser = null;
			this.container.focus( { preventScroll: true } );
		}
		if ( this.pendingEdge ) {
			this.pendingEdge = null;
			this._scheduleRender();
		}
	};

	// ---- inspector cards -----------------------------------------------------

	Graph.prototype._cardKeyFor = function ( kind, id ) {
		return kind + ':' + id;
	};

	Graph.prototype._openPinnedCards = function () {
		var self = this;
		Object.keys( this.doc.things ).forEach( function ( id ) {
			if ( self.doc.things[ id ].pinned ) {
				self._openCard( 'thing', id );
			}
		} );
		Object.keys( this.doc.relationships ).forEach( function ( id ) {
			if ( self.doc.relationships[ id ].pinned ) {
				self._openCard( 'rel', id );
			}
		} );
	};

	Graph.prototype._closeCard = function ( key ) {
		var card = this.cards[ key ];
		if ( card ) {
			card.el.remove();
			delete this.cards[ key ];
		}
	};

	Graph.prototype._closeAllCards = function () {
		var self = this;
		Object.keys( this.cards ).forEach( function ( key ) {
			self._closeCard( key );
		} );
	};

	Graph.prototype._closeUnpinnedCardsExcept = function ( keepKey ) {
		var self = this;
		Object.keys( this.cards ).forEach( function ( key ) {
			if ( key === keepKey ) {
				return;
			}
			var card = self.cards[ key ];
			var obj = card.kind === 'thing' ?
				self.doc.things[ card.id ] : self.doc.relationships[ card.id ];
			if ( !obj || !obj.pinned ) {
				self._closeCard( key );
			}
		} );
	};

	Graph.prototype._focusCardField = function ( key, field ) {
		var card = this.cards[ key ];
		if ( card && card.fields && card.fields[ field ] ) {
			card.fields[ field ].focus();
		}
	};

	Graph.prototype._openCard = function ( kind, id ) {
		var key = this._cardKeyFor( kind, id );
		if ( this.cards[ key ] ) {
			return;
		}
		var card = {
			kind: kind,
			id: id,
			el: el( 'div', 'inf-card', this.overlay ),
			fields: {},
			offset: { x: THING_RADIUS + 14, y: -10 }
		};
		this.cards[ key ] = card;
		this._buildCardContent( card );
		this._makeCardDraggable( card );
		this._positionCards();
	};

	Graph.prototype._rebuildCard = function ( card ) {
		card.el.textContent = '';
		card.fields = {};
		this._buildCardContent( card );
	};

	Graph.prototype._makeCardDraggable = function ( card ) {
		var self = this;
		var header = card.el.querySelector( '.inf-card-head' );
		if ( !header ) {
			return;
		}
		header.addEventListener( 'pointerdown', function ( e ) {
			if ( isFormField( e.target ) ) {
				return;
			}
			e.preventDefault();
			header.setPointerCapture( e.pointerId );
			var startX = e.clientX;
			var startY = e.clientY;
			var base = { x: card.offset.x, y: card.offset.y };
			function move( ev ) {
				var z = self.doc.view.zoom;
				card.offset.x = base.x + ( ev.clientX - startX ) / z;
				card.offset.y = base.y + ( ev.clientY - startY ) / z;
				self._positionCards();
			}
			function up() {
				header.removeEventListener( 'pointermove', move );
				header.removeEventListener( 'pointerup', up );
			}
			header.addEventListener( 'pointermove', move );
			header.addEventListener( 'pointerup', up );
		} );
	};

	Graph.prototype._buildCardContent = function ( card ) {
		if ( card.kind === 'thing' ) {
			this._buildThingCard( card );
		} else {
			this._buildRelCard( card );
		}
	};

	Graph.prototype._cardHeader = function ( card, titleText, obj ) {
		var self = this;
		var head = el( 'div', 'inf-card-head', card.el );
		var title = el( 'span', 'inf-card-title', head );
		title.textContent = titleText;
		var pin = el( 'button', 'inf-icon-btn' + ( obj.pinned ? ' inf-pinned' : '' ), head );
		pin.type = 'button';
		pin.title = obj.pinned ? 'Unpin card' : 'Pin card open';
		pin.textContent = '📌';
		if ( !this.editable || obj.pending ) {
			pin.disabled = true;
		}
		pin.addEventListener( 'click', function () {
			obj.pinned = !obj.pinned;
			pin.classList.toggle( 'inf-pinned', obj.pinned );
			pin.title = obj.pinned ? 'Unpin card' : 'Pin card open';
			self._markLayoutDirty();
		} );
		var close = el( 'button', 'inf-icon-btn', head );
		close.type = 'button';
		close.title = 'Close';
		close.textContent = '×';
		close.addEventListener( 'click', function () {
			if ( card.id === PENDING ) {
				self._cancelCreateThing();
			}
			self._closeCard( self._cardKeyFor( card.kind, card.id ) );
		} );
		return head;
	};

	/** Human label for an endpoint: a page title, or a bracketed edge description. */
	Graph.prototype._endpointLabel = function ( id ) {
		var thing = this.doc.things[ id ];
		if ( thing ) {
			return thing.name || '?';
		}
		var rel = this.doc.relationships[ id ];
		if ( !rel ) {
			return '?';
		}
		return '[' + ( rel.tag ||
			this._endpointLabel( rel.from ) + '→' + this._endpointLabel( rel.to ) ) + ']';
	};

	Graph.prototype._buildThingCard = function ( card ) {
		var self = this;
		var thing = this.doc.things[ card.id ];
		if ( !thing ) {
			return;
		}
		var isPending = !!thing.pending;
		this._cardHeader( card, isPending ? 'New page' : 'Page', thing );
		var body = el( 'div', 'inf-card-body', card.el );

		// name IS the page title; committing a change moves the page
		var name = el( 'input', 'inf-input', body );
		name.placeholder = isPending ? 'page title…' : 'page title';
		name.value = thing.name;
		name.readOnly = !this.editable;
		function commitName() {
			var value = name.value.trim();
			if ( isPending ) {
				self._commitCreateThing( value, card.connectFrom );
				return;
			}
			if ( value && value !== thing.name ) {
				self._storeCall(
					self.store.renameThing( card.id, value ),
					'Moved "' + card.id + '" to "' + value + '".'
				).catch( function () {
					name.value = thing.name;
				} );
			} else {
				name.value = thing.name;
			}
		}
		name.addEventListener( 'keydown', function ( e ) {
			if ( e.key === 'Enter' ) {
				commitName();
				self.container.focus( { preventScroll: true } );
			} else if ( e.key === 'Escape' ) {
				if ( isPending ) {
					self._cancelCreateThing();
				} else {
					name.value = thing.name;
					self.container.focus( { preventScroll: true } );
					self._select( null );
				}
			}
			e.stopPropagation();
		} );
		name.addEventListener( 'blur', function () {
			commitName();
		} );
		card.fields.name = name;

		if ( isPending ) {
			var pendingHint = el( 'div', 'inf-muted', body );
			pendingHint.textContent = 'Enter a title to create the page (or reuse an existing one).';
			return;
		}

		if ( thing.missing ) {
			var missing = el( 'div', 'inf-muted', body );
			missing.textContent = 'This page does not exist yet.';
		}

		var openRow = el( 'div', 'inf-row', body );
		var open = el( 'a', 'inf-link-go', openRow );
		open.textContent = '↗ open page';
		var href = this.resolveHref( card.id );
		if ( href ) {
			open.href = href;
		}

		// type = category
		if ( this.editable ) {
			var typeSelect = el( 'select', 'inf-input', body );
			var noType = el( 'option', null, typeSelect );
			noType.value = '';
			noType.textContent = '(no type)';
			var known = this.store.knownTypes();
			if ( thing.type && known.indexOf( thing.type ) === -1 ) {
				known = known.concat( [ thing.type ] );
			}
			known.forEach( function ( typeName ) {
				var opt = el( 'option', null, typeSelect );
				opt.value = typeName;
				opt.textContent = typeName;
			} );
			var newTypeOpt = el( 'option', null, typeSelect );
			newTypeOpt.value = '__new__';
			newTypeOpt.textContent = '+ new type…';
			typeSelect.value = thing.type || '';
			typeSelect.addEventListener( 'change', function () {
				var value = typeSelect.value;
				if ( value === '__new__' ) {
					value = window.prompt( 'Type name (a category, e.g. Programs):' );
					if ( !value || !value.trim() ) {
						typeSelect.value = thing.type || '';
						return;
					}
					value = value.trim();
				}
				self._storeCall( self.store.setType( card.id, value || null ) );
			} );
		} else if ( thing.type ) {
			var typeRow = el( 'div', 'inf-muted', body );
			typeRow.textContent = 'Type: ' + thing.type;
		}

		// every relationship this page takes part in
		var relIds = Object.keys( this.doc.relationships ).filter( function ( rid ) {
			var rel = self.doc.relationships[ rid ];
			return rel.from === card.id || rel.to === card.id;
		} );
		if ( relIds.length ) {
			var relTitle = el( 'div', 'inf-section-title', body );
			relTitle.textContent = 'Relationships';
			var relList = el( 'div', 'inf-rel-list', body );
			relIds.forEach( function ( rid ) {
				var rel = self.doc.relationships[ rid ];
				var outgoing = rel.from === card.id;
				var other = outgoing ? rel.to : rel.from;
				var row = el( 'button', 'inf-rel-item', relList );
				row.type = 'button';
				row.textContent = ( outgoing ? '→ ' : '← ' ) +
					( rel.tag ? rel.tag + ' ' : '' ) +
					( rel.inferred ? '∴ ' : '' ) +
					self._endpointLabel( other );
				row.addEventListener( 'click', function () {
					self._select( 'rel', rid );
				} );
			} );
		}

		if ( this.pageApi && this.editable ) {
			this._buildPageEditor( body, card.id );
		}

		if ( this.editable ) {
			var del = el( 'button', 'inf-btn inf-btn-danger', body );
			del.type = 'button';
			del.textContent = 'Remove from view';
			del.title = 'Removes the page from this diagram; the page itself is kept.';
			del.addEventListener( 'click', function () {
				self._storeCall( self.store.removeThing( card.id ) );
			} );
		}
	};

	/**
	 * Edit the page's full wikitext without leaving the canvas. Loads
	 * through pageApi.load and saves through pageApi.save.
	 */
	Graph.prototype._buildPageEditor = function ( body, title ) {
		var self = this;
		var section = el( 'div', 'inf-page-editor', body );
		var toggle = el( 'button', 'inf-btn', section );
		toggle.type = 'button';
		toggle.textContent = 'Edit page source';
		var editorEl = null;

		toggle.addEventListener( 'click', function () {
			if ( editorEl ) {
				editorEl.remove();
				editorEl = null;
				return;
			}
			editorEl = el( 'div', 'inf-page-editor', section );
			var status = el( 'div', 'inf-muted', editorEl );
			status.textContent = 'Loading ' + title + '…';
			var textarea = el( 'textarea', 'inf-input', editorEl );
			textarea.disabled = true;
			var save = el( 'button', 'inf-btn inf-btn-primary', editorEl );
			save.type = 'button';
			save.textContent = 'Save page';
			save.disabled = true;

			self.pageApi.load( title ).then( function ( result ) {
				textarea.value = result.text || '';
				textarea.disabled = false;
				save.disabled = false;
				status.textContent = result.exists ?
					'Editing "' + title + '"' :
					'"' + title + '" does not exist yet — saving will create it.';
			}, function () {
				status.textContent = 'Could not load "' + title + '".';
			} );

			textarea.addEventListener( 'keydown', function ( e ) {
				e.stopPropagation();
			} );
			save.addEventListener( 'click', function () {
				save.disabled = true;
				save.textContent = 'Saving…';
				self.pageApi.save( title, textarea.value ).then( function () {
					save.disabled = false;
					save.textContent = 'Save page';
					status.textContent = 'Saved "' + title + '".';
					self.notify( 'Saved page "' + title + '".', false );
				}, function ( err ) {
					save.disabled = false;
					save.textContent = 'Save page';
					status.textContent = 'Saving failed.';
					self.notify( 'Saving "' + title + '" failed: ' + err, true );
				} );
			} );
		} );
	};

	Graph.prototype._buildRelCard = function ( card ) {
		var self = this;
		var rel = this.doc.relationships[ card.id ];
		if ( !rel ) {
			return;
		}
		this._cardHeader( card,
			this._endpointLabel( rel.from ) + ' → ' + this._endpointLabel( rel.to ), rel );
		var body = el( 'div', 'inf-card-body', card.el );

		var stored = el( 'div', 'inf-muted', body );
		stored.textContent = 'Stored on "' + card.id.split( '#' )[ 0 ] + '"';

		// the article this relationship lives in, as rendered wiki text —
		// auto-opened when just reading the diagram, on demand while editing
		this._buildArticlePanel( card, body, card.id.split( '#' )[ 0 ], !this.editable );

		// tag picker
		var select = el( 'select', 'inf-input', body );
		select.disabled = !this.editable;
		var none = el( 'option', null, select );
		none.value = '';
		none.textContent = '(no tag)';
		var tags = this.store.knownTags();
		if ( rel.tag && tags.indexOf( rel.tag ) === -1 ) {
			tags = tags.concat( [ rel.tag ] );
		}
		tags.forEach( function ( tagName ) {
			var opt = el( 'option', null, select );
			opt.value = tagName;
			opt.textContent = tagName;
		} );
		var createOpt = el( 'option', null, select );
		createOpt.value = '__new__';
		createOpt.textContent = '+ new tag…';
		select.value = rel.tag || '';
		select.addEventListener( 'change', function () {
			var value = select.value;
			if ( value === '__new__' ) {
				value = window.prompt( 'Tag name:' );
				if ( !value || !value.trim() ) {
					select.value = rel.tag || '';
					return;
				}
				value = value.trim();
			}
			self._storeCall( self.store.updateEdge( card.id, { tag: value } ) );
		} );

		// inferred: deduced, not directly observed
		var infLabel = el( 'label', 'inf-check', body );
		var infBox = el( 'input', null, infLabel );
		infBox.type = 'checkbox';
		infBox.checked = !!rel.inferred;
		infBox.disabled = !this.editable;
		infLabel.appendChild( document.createTextNode( '∴ inferred (not directly observed)' ) );
		infBox.addEventListener( 'change', function () {
			self._storeCall( self.store.updateEdge( card.id, { inferred: infBox.checked } ) );
		} );

		// evidence — each item is a <ref> citation on the source page,
		// rendered by the wiki's built-in citation system
		var evTitle = el( 'div', 'inf-section-title', body );
		evTitle.textContent = 'Citations';
		var evList = el( 'div', 'inf-evidence', body );
		var evidence = rel.evidence.map( function ( ev ) {
			return typeof ev === 'string' ? ev : '';
		} );
		function pushEvidence() {
			self._storeCall( self.store.updateEdge( card.id, {
				evidence: evidence.filter( function ( ev ) {
					return ev.trim() !== '';
				} )
			} ) );
		}
		function renderEvidence() {
			evList.textContent = '';
			evidence.forEach( function ( ev, i ) {
				var row = el( 'div', 'inf-evidence-item', evList );
				var cite = el( 'textarea', 'inf-input', row );
				cite.placeholder = 'citation wikitext — e.g. [https://… quote] or {{cite web|…}}';
				cite.rows = 2;
				cite.value = ev;
				cite.readOnly = !self.editable;
				cite.addEventListener( 'change', function () {
					evidence[ i ] = cite.value;
					pushEvidence();
				} );
				cite.addEventListener( 'keydown', function ( e ) {
					e.stopPropagation();
				} );
				if ( self.editable ) {
					var rm = el( 'button', 'inf-icon-btn', row );
					rm.type = 'button';
					rm.title = 'Remove citation';
					rm.textContent = '×';
					rm.addEventListener( 'click', function () {
						evidence.splice( i, 1 );
						renderEvidence();
						pushEvidence();
					} );
				}
			} );
			if ( !evidence.length && !self.editable ) {
				var empty = el( 'div', 'inf-muted', evList );
				empty.textContent = 'No citations recorded yet.';
			}
		}
		renderEvidence();
		if ( this.editable ) {
			var add = el( 'button', 'inf-btn', body );
			add.type = 'button';
			add.textContent = '+ add citation';
			add.addEventListener( 'click', function () {
				evidence.push( '' );
				renderEvidence();
			} );

			var del = el( 'button', 'inf-btn inf-btn-danger', body );
			del.type = 'button';
			del.textContent = 'Delete relationship';
			del.title = 'Removes the {{#inference:…}} call from the source page.';
			del.addEventListener( 'click', function () {
				self._storeCall( self.store.removeEdge( card.id ) );
			} );
		}
	};

	/**
	 * A resizable panel showing a page's rendered wiki text inside a card.
	 * Only built when a renderPage hook is available; opened immediately
	 * when `autoOpen` (view mode), otherwise behind a toggle button.
	 */
	Graph.prototype._buildArticlePanel = function ( card, body, title, autoOpen ) {
		var self = this;
		if ( !this.renderPage ) {
			return;
		}
		card.el.classList.add( 'inf-card-article' );
		var section = el( 'div', 'inf-article', body );
		var toggle = el( 'button', 'inf-btn', section );
		toggle.type = 'button';
		var panel = null;
		function open() {
			if ( panel ) {
				return;
			}
			toggle.textContent = 'Hide article';
			panel = el( 'div', 'inf-article-panel', section );
			var status = el( 'div', 'inf-muted', panel );
			status.textContent = 'Loading "' + title + '"…';
			self.renderPage( title ).then( function ( html ) {
				if ( !panel ) {
					return;
				}
				panel.textContent = '';
				var content = el( 'div', 'inf-article-content mw-parser-output', panel );
				content.innerHTML = html || '';
			}, function () {
				if ( panel ) {
					status.textContent = 'Could not load "' + title + '".';
				}
			} );
		}
		function close() {
			if ( panel ) {
				panel.remove();
				panel = null;
			}
			toggle.textContent = 'Show article';
		}
		toggle.addEventListener( 'click', function () {
			if ( panel ) {
				close();
			} else {
				open();
			}
		} );
		if ( autoOpen ) {
			open();
		} else {
			close();
		}
	};

	Graph.prototype._positionCards = function () {
		var self = this;
		Object.keys( this.cards ).forEach( function ( key ) {
			var card = self.cards[ key ];
			var anchor;
			if ( card.kind === 'thing' ) {
				var t = self.doc.things[ card.id ];
				if ( !t ) {
					self._closeCard( key );
					return;
				}
				anchor = { x: t.x, y: t.y };
			} else {
				var rel = self.doc.relationships[ card.id ];
				if ( !rel ) {
					self._closeCard( key );
					return;
				}
				anchor = self._bezierPoint( rel, 0.5 );
			}
			var s = self._w2s( anchor.x + card.offset.x, anchor.y + card.offset.y );
			card.el.style.left = clamp( s.x, 0, Math.max( 0, self.container.clientWidth - card.el.offsetWidth ) ) + 'px';
			card.el.style.top = clamp( s.y, 0, Math.max( 0, self.container.clientHeight - card.el.offsetHeight ) ) + 'px';
		} );
	};

	// ---- rendering --------------------------------------------------------------

	Graph.prototype._scheduleRender = function () {
		if ( this._renderQueued ) {
			return;
		}
		this._renderQueued = true;
		var self = this;
		requestAnimationFrame( function () {
			self._renderQueued = false;
			self._render();
		} );
	};

	Graph.prototype._render = function () {
		var ctx = this.canvas.getContext( '2d' );
		var dpr = window.devicePixelRatio || 1;
		var w = this.container.clientWidth;
		var h = this.container.clientHeight;
		var v = this.doc.view;

		ctx.setTransform( 1, 0, 0, 1, 0, 0 );
		ctx.fillStyle = this._theme().bg;
		ctx.fillRect( 0, 0, this.canvas.width, this.canvas.height );

		ctx.setTransform(
			dpr * v.zoom, 0, 0, dpr * v.zoom,
			dpr * ( w / 2 - v.x * v.zoom ),
			dpr * ( h / 2 - v.y * v.zoom )
		);
		var viewRect = {
			left: v.x - w / 2 / v.zoom,
			right: v.x + w / 2 / v.zoom,
			top: v.y - h / 2 / v.zoom,
			bottom: v.y + h / 2 / v.zoom
		};

		this._drawGrid( ctx, viewRect, v.zoom );
		this._drawRelationships( ctx, v.zoom );
		this._drawThings( ctx, v.zoom );
		this._drawGhost( ctx, v.zoom );
		this._drawPendingEdge( ctx );
		this._positionCards();
	};

	// Port of the native app's draw_grid: adaptive power-of-two spacing.
	Graph.prototype._drawGrid = function ( ctx, view, zoom ) {
		var step = Math.pow( 2, Math.round( Math.log2( 60 / zoom ) ) );
		var gridRgb = this._theme().gridRgb;
		[ [ step, 0.10 ], [ step * 4, 0.22 ] ].forEach( function ( pair ) {
			var s = pair[ 0 ];
			ctx.strokeStyle = 'rgba(' + gridRgb + ',' + pair[ 1 ] + ')';
			ctx.lineWidth = 1 / zoom;
			ctx.beginPath();
			for ( var x = Math.floor( view.left / s ) * s; x <= view.right; x += s ) {
				ctx.moveTo( x, view.top );
				ctx.lineTo( x, view.bottom );
			}
			for ( var y = Math.floor( view.top / s ) * s; y <= view.bottom; y += s ) {
				ctx.moveTo( view.left, y );
				ctx.lineTo( view.right, y );
			}
			ctx.stroke();
		} );
	};

	/** Is this relationship itself the endpoint of another relationship? */
	Graph.prototype._isRelEndpoint = function ( id ) {
		var rels = this.doc.relationships;
		var ids = Object.keys( rels );
		for ( var i = 0; i < ids.length; i++ ) {
			if ( rels[ ids[ i ] ].from === id || rels[ ids[ i ] ].to === id ) {
				return true;
			}
		}
		return false;
	};

	Graph.prototype._drawRelationships = function ( ctx, zoom ) {
		var self = this;
		var theme = this._theme();
		Object.keys( this.doc.relationships ).forEach( function ( id ) {
			var rel = self.doc.relationships[ id ];
			var a = self._anchorOf( rel.from );
			var b = self._anchorOf( rel.to );
			var h = self._relHandle( rel );
			var color = rel.tag ? rel.tagColor : '#8d8d8d';
			var selected = self.selection && self.selection.kind === 'rel' && self.selection.id === id;
			var hovered = self.hover && self.hover.kind === 'rel' && self.hover.id === id;

			var start = trimToRim( a, h.x, h.y );
			var end = trimToRim( b, h.x, h.y );

			ctx.strokeStyle = color;
			ctx.lineWidth = ( selected || hovered ? 2.5 : 1.5 );
			if ( rel.inferred ) {
				ctx.setLineDash( [ 7, 5 ] );
			}
			ctx.beginPath();
			ctx.moveTo( start.x, start.y );
			ctx.quadraticCurveTo( h.x, h.y, end.x, end.y );
			ctx.stroke();
			ctx.setLineDash( [] );

			// arrowhead pointing into the target
			var angle = Math.atan2( end.y - h.y, end.x - h.x );
			var ah = 9;
			ctx.fillStyle = color;
			ctx.beginPath();
			ctx.moveTo( end.x, end.y );
			ctx.lineTo( end.x - ah * Math.cos( angle - 0.42 ), end.y - ah * Math.sin( angle - 0.42 ) );
			ctx.lineTo( end.x - ah * Math.cos( angle + 0.42 ), end.y - ah * Math.sin( angle + 0.42 ) );
			ctx.closePath();
			ctx.fill();

			// label pill at the curve midpoint (also the anchor for
			// relationships that point at this relationship)
			var label = rel.tag || '';
			if ( rel.inferred ) {
				label = '∴' + ( label ? ' ' + label : '' );
			}
			if ( rel.evidence.length ) {
				label += ( label ? ' ' : '' ) + '⧉' + rel.evidence.length;
			}
			if ( !label && self._isRelEndpoint( id ) ) {
				label = '◦';
			}
			if ( label ) {
				var mid = self._bezierPoint( rel, 0.5 );
				ctx.font = ( rel.inferred ? 'italic ' : '' ) + '11px sans-serif';
				var tw = ctx.measureText( label ).width;
				ctx.fillStyle = theme.nodeFill;
				roundRect( ctx, mid.x - tw / 2 - 6, mid.y - 9, tw + 12, 18, 9 );
				ctx.fill();
				ctx.strokeStyle = color;
				ctx.lineWidth = 1;
				if ( rel.inferred ) {
					ctx.setLineDash( [ 3, 3 ] );
				}
				roundRect( ctx, mid.x - tw / 2 - 6, mid.y - 9, tw + 12, 18, 9 );
				ctx.stroke();
				ctx.setLineDash( [] );
				ctx.fillStyle = theme.text;
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText( label, mid.x, mid.y );
			}

			// reshaping handle
			if ( selected && self.editable ) {
				ctx.save();
				ctx.translate( h.x, h.y );
				ctx.rotate( Math.PI / 4 );
				ctx.fillStyle = theme.text;
				ctx.fillRect( -5 / zoom, -5 / zoom, 10 / zoom, 10 / zoom );
				ctx.restore();
			}
		} );
	};

	Graph.prototype._drawThings = function ( ctx, zoom ) {
		var self = this;
		var theme = this._theme();
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		Object.keys( this.doc.things ).forEach( function ( id ) {
			var t = self.doc.things[ id ];
			var selected = self.selection && self.selection.kind === 'thing' && self.selection.id === id;
			var hovered = self.hover && self.hover.kind === 'thing' && self.hover.id === id;

			ctx.fillStyle = theme.nodeFill;
			ctx.beginPath();
			ctx.arc( t.x, t.y, THING_RADIUS, 0, Math.PI * 2 );
			ctx.fill();
			ctx.strokeStyle = t.missing ? theme.danger : t.color;
			ctx.lineWidth = selected || hovered ? 3 : 1.5;
			if ( t.missing || t.pending ) {
				ctx.setLineDash( [ 5, 4 ] );
			}
			ctx.stroke();
			ctx.setLineDash( [] );
			if ( selected ) {
				ctx.strokeStyle = 'rgba(' + theme.ghostRgb + ',0.35)';
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.arc( t.x, t.y, THING_RADIUS + 4, 0, Math.PI * 2 );
				ctx.stroke();
			}

			// title, wrapped to the circle; red-link color for missing pages
			ctx.fillStyle = t.missing ? theme.danger : theme.text;
			ctx.font = '12px sans-serif';
			var lines = wrapText( ctx, t.name || '…', 54, 3 );
			var lh = 13;
			lines.forEach( function ( line, i ) {
				ctx.fillText( line, t.x, t.y + ( i - ( lines.length - 1 ) / 2 ) * lh );
			} );

			// type caption under the circle
			if ( t.type ) {
				ctx.font = 'italic 10px sans-serif';
				ctx.fillStyle = theme.muted;
				ctx.fillText( t.type, t.x, t.y + THING_RADIUS + 11 );
			}
		} );
	};

	Graph.prototype._drawGhost = function ( ctx, zoom ) {
		var d = this.drag;
		if ( !d || d.mode !== 'connect' || !d.ghostTo ) {
			return;
		}
		var from = this._anchorOf( d.id );
		var ghostRgb = this._theme().ghostRgb;
		ctx.strokeStyle = 'rgba(' + ghostRgb + ',0.55)';
		ctx.lineWidth = 1.5;
		ctx.setLineDash( [ 6, 5 ] );
		ctx.beginPath();
		ctx.moveTo( from.x, from.y );
		ctx.lineTo( d.ghostTo.x, d.ghostTo.y );
		ctx.stroke();
		ctx.setLineDash( [] );
		var over = this._thingAt( d.ghostTo ) || this._relAt( d.ghostTo );
		if ( !over || over === d.id ) {
			ctx.strokeStyle = 'rgba(' + ghostRgb + ',0.35)';
			ctx.beginPath();
			ctx.arc( d.ghostTo.x, d.ghostTo.y, THING_RADIUS, 0, Math.PI * 2 );
			ctx.stroke();
		}
	};

	Graph.prototype._drawPendingEdge = function ( ctx ) {
		if ( !this.pendingEdge ) {
			return;
		}
		var a = this._anchorOf( this.pendingEdge.from );
		var b = this._anchorOf( this.pendingEdge.to );
		var ghostRgb = this._theme().ghostRgb;
		ctx.strokeStyle = 'rgba(' + ghostRgb + ',0.55)';
		ctx.lineWidth = 1.5;
		ctx.setLineDash( [ 6, 5 ] );
		ctx.beginPath();
		ctx.moveTo( a.x, a.y );
		ctx.lineTo( b.x, b.y );
		ctx.stroke();
		ctx.setLineDash( [] );
	};

	function wrapText( ctx, text, maxWidth, maxLines ) {
		var words = String( text ).split( /\s+/ ).filter( Boolean );
		if ( !words.length ) {
			return [ '' ];
		}
		var lines = [];
		var line = '';
		for ( var i = 0; i < words.length; i++ ) {
			var candidate = line ? line + ' ' + words[ i ] : words[ i ];
			if ( ctx.measureText( candidate ).width <= maxWidth || !line ) {
				line = candidate;
			} else {
				lines.push( line );
				line = words[ i ];
				if ( lines.length === maxLines - 1 ) {
					break;
				}
			}
		}
		var rest = words.join( ' ' );
		lines.push( line );
		var joined = lines.join( ' ' );
		if ( joined.length < rest.length ) {
			var last = lines[ lines.length - 1 ];
			while ( last && ctx.measureText( last + '…' ).width > maxWidth ) {
				last = last.slice( 0, -1 );
			}
			lines[ lines.length - 1 ] = last + '…';
		}
		return lines;
	}

	/** Point on the rim of `anchor` (centre + radius) pointing toward cx,cy. */
	function trimToRim( anchor, cx, cy ) {
		var dx = cx - anchor.x;
		var dy = cy - anchor.y;
		var len = Math.hypot( dx, dy ) || 1;
		return {
			x: anchor.x + dx / len * anchor.r,
			y: anchor.y + dy / len * anchor.r
		};
	}

	function roundRect( ctx, x, y, w, h, r ) {
		ctx.beginPath();
		ctx.moveTo( x + r, y );
		ctx.arcTo( x + w, y, x + w, y + h, r );
		ctx.arcTo( x + w, y + h, x, y + h, r );
		ctx.arcTo( x, y + h, x, y, r );
		ctx.arcTo( x, y, x + w, y, r );
		ctx.closePath();
	}

	Graph.PENDING = PENDING;
	return Graph;
} ) );
