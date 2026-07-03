/**
 * Inferences diagram canvas — standalone, no MediaWiki dependencies.
 *
 * A port of the native egui app's scene: an infinite pannable/zoomable
 * canvas with an adaptive grid, "things" (circular nodes, optionally
 * linked to wiki pages), tagged "relationships" (curved edges carrying
 * evidence), and pinnable inspector cards.
 *
 * Interactions (edit mode):
 *   right-click empty space ... add a thing
 *   right-drag from a thing .. connect it (release on empty space to
 *                              create and connect a new thing)
 *   left-drag a thing ........ move it
 *   left/middle-drag empty ... pan;  wheel ............... zoom
 *   click thing/edge ......... open inspector card (pin to keep open)
 *   drag the diamond ......... reshape a selected edge
 *   Delete ................... delete selection;  Ctrl+Z/Y ... undo/redo
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
	var CLICK_SLOP = 4; // px of screen movement that still counts as a click
	var RIGHT_DEADZONE = 10; // matches the native app's radial deadzone
	var MIN_ZOOM = 0.2;
	var MAX_ZOOM = 2.5;

	var PALETTE = [
		'#f0f0f0', '#e5484d', '#f76b15', '#ffc53d', '#46a758',
		'#00a2c7', '#3e63dd', '#8e4ec6', '#e93d82', '#8d8d8d'
	];

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
	 * Coerce an arbitrary parsed JSON value into a well-formed document,
	 * dropping relationships whose endpoints are missing (the native app
	 * does the same in its retain() pass).
	 */
	function normalizeDoc( raw ) {
		raw = ( raw && typeof raw === 'object' ) ? raw : {};
		var doc = {
			version: 1,
			view: {
				x: Number( raw.view && raw.view.x ) || 0,
				y: Number( raw.view && raw.view.y ) || 0,
				zoom: clamp( Number( raw.view && raw.view.zoom ) || 1, MIN_ZOOM, MAX_ZOOM )
			},
			tags: {},
			things: {},
			relationships: {},
			nextId: Math.max( 1, Math.floor( Number( raw.nextId ) || 1 ) )
		};
		var maxId = 0;
		function seen( id ) {
			var n = parseInt( id, 10 );
			if ( !isNaN( n ) && n > maxId ) {
				maxId = n;
			}
		}
		Object.keys( raw.tags || {} ).forEach( function ( id ) {
			var t = raw.tags[ id ] || {};
			seen( id );
			doc.tags[ id ] = {
				name: String( t.name || '' ),
				color: String( t.color || PALETTE[ 1 ] )
			};
		} );
		Object.keys( raw.things || {} ).forEach( function ( id ) {
			var t = raw.things[ id ] || {};
			seen( id );
			doc.things[ id ] = {
				name: String( t.name || '' ),
				color: String( t.color || PALETTE[ 0 ] ),
				x: Number( t.x ) || 0,
				y: Number( t.y ) || 0,
				pinned: !!t.pinned,
				link: String( t.link || '' )
			};
		} );
		// Relationship endpoints may be things OR other relationships
		// (reification: "unix domain socket" -> the "connects" edge).
		// Keep a relationship once both endpoints resolve to something
		// kept; this fixpoint also drops self-references and cycles,
		// mirroring the native app's retain() pass.
		var candidates = {};
		Object.keys( raw.relationships || {} ).forEach( function ( id ) {
			var r = raw.relationships[ id ] || {};
			seen( id );
			if ( r.from == null || r.to == null || String( r.from ) === String( r.to ) ) {
				return;
			}
			candidates[ id ] = r;
		} );
		var kept = {};
		var changed = true;
		while ( changed ) {
			changed = false;
			Object.keys( candidates ).forEach( function ( id ) {
				if ( kept[ id ] ) {
					return;
				}
				var r = candidates[ id ];
				if ( ( doc.things[ r.from ] || kept[ r.from ] ) &&
					( doc.things[ r.to ] || kept[ r.to ] ) ) {
					kept[ id ] = r;
					changed = true;
				}
			} );
		}
		Object.keys( kept ).forEach( function ( id ) {
			var r = kept[ id ];
			var rel = {
				from: String( r.from ),
				to: String( r.to ),
				tag: ( r.tag != null && doc.tags[ r.tag ] ) ? String( r.tag ) : null,
				hx: Number( r.hx ) || 0,
				hy: Number( r.hy ) || 0,
				hset: !!r.hset && !isNaN( Number( r.hx ) ) && !isNaN( Number( r.hy ) ),
				pinned: !!r.pinned,
				evidence: []
			};
			( Array.isArray( r.evidence ) ? r.evidence : [] ).forEach( function ( ev ) {
				rel.evidence.push( {
					source: String( ( ev && ev.source ) || '' ),
					snippet: String( ( ev && ev.snippet ) || '' )
				} );
			} );
			doc.relationships[ id ] = rel;
		} );
		if ( doc.nextId <= maxId ) {
			doc.nextId = maxId + 1;
		}
		return doc;
	}

	/**
	 * @param {HTMLElement} container
	 * @param {Object} options
	 * @param {Object} options.doc parsed diagram document
	 * @param {boolean} [options.editable=false]
	 * @param {Function} [options.onDirtyChange] called with (isDirty)
	 * @param {Function} [options.resolveHref] title -> url (or null)
	 * @param {Function} [options.navigate] called with (title) on view-mode node click
	 */
	function Graph( container, options ) {
		options = options || {};
		this.container = container;
		this.editable = !!options.editable;
		this.onDirtyChange = options.onDirtyChange || function () {};
		this.resolveHref = options.resolveHref || function () { return null; };
		this.navigate = options.navigate || function () {};
		this.doc = normalizeDoc( options.doc );

		this.dirty = false;
		this.undoStack = [];
		this.redoStack = [];
		this.selection = null; // { kind: 'thing'|'rel', id }
		this.hover = null;
		this.drag = null; // active pointer gesture
		this.cards = {}; // "kind:id" -> card record
		this.tagChooser = null;

		this._buildDom();
		this._bindEvents();
		this._openPinnedCards();
		this.zoomToFit( true );
		this._scheduleRender();
	}

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
			'right-click: add thing · right-drag from a thing: connect · drag: pan · wheel: zoom' :
			'drag: pan · wheel: zoom · click a thing to follow its link';
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

	// ---- coordinate transforms -------------------------------------------

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

	// ---- hit testing ------------------------------------------------------

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

	/**
	 * Where an endpoint attaches: a thing's center, or — when the endpoint
	 * is another relationship — that edge's midpoint (its label pill).
	 * `r` is the rim radius to trim the curve to. The visited set guards
	 * against cycles, which normalizeDoc already drops but a stale doc
	 * mid-edit shouldn't be able to hang the renderer.
	 */
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

	/** Curve control point; edges never reshaped by hand follow their endpoints. */
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
		var h = this._relHandle( rel, visited );
		var mt = 1 - t;
		return {
			x: mt * mt * a.x + 2 * mt * t * h.x + t * t * b.x,
			y: mt * mt * a.y + 2 * mt * t * h.y + t * t * b.y
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

	// ---- mutations --------------------------------------------------------

	Graph.prototype._pushUndo = function () {
		this.undoStack.push( JSON.stringify( this.doc ) );
		if ( this.undoStack.length > 100 ) {
			this.undoStack.shift();
		}
		this.redoStack.length = 0;
	};

	Graph.prototype._markDirty = function () {
		if ( !this.dirty ) {
			this.dirty = true;
			this.onDirtyChange( true );
		}
		this._scheduleRender();
	};

	Graph.prototype.markSaved = function () {
		this.dirty = false;
		this.onDirtyChange( false );
	};

	Graph.prototype.undo = function () {
		if ( !this.undoStack.length ) {
			return;
		}
		this.redoStack.push( JSON.stringify( this.doc ) );
		this.doc = normalizeDoc( JSON.parse( this.undoStack.pop() ) );
		this._afterHistoryJump();
	};

	Graph.prototype.redo = function () {
		if ( !this.redoStack.length ) {
			return;
		}
		this.undoStack.push( JSON.stringify( this.doc ) );
		this.doc = normalizeDoc( JSON.parse( this.redoStack.pop() ) );
		this._afterHistoryJump();
	};

	Graph.prototype._afterHistoryJump = function () {
		this.selection = null;
		this._closeAllCards();
		this._openPinnedCards();
		this._markDirty();
	};

	Graph.prototype._newId = function () {
		return String( this.doc.nextId++ );
	};

	Graph.prototype._addThing = function ( wpt ) {
		this._pushUndo();
		var id = this._newId();
		this.doc.things[ id ] = {
			name: '',
			color: PALETTE[ 0 ],
			x: wpt.x,
			y: wpt.y,
			pinned: false,
			link: ''
		};
		this._markDirty();
		this._select( 'thing', id );
		this._focusCardField( 'thing:' + id, 'name' );
		return id;
	};

	/** Endpoints may be thing ids or relationship ids. */
	Graph.prototype._addRelationship = function ( fromId, toId ) {
		this._pushUndo();
		var id = this._newId();
		this.doc.relationships[ id ] = {
			from: fromId,
			to: toId,
			tag: null,
			hx: 0,
			hy: 0,
			hset: false,
			pinned: false,
			evidence: []
		};
		this._markDirty();
		return id;
	};

	/**
	 * Remove every relationship whose endpoint chain reaches a deleted
	 * id — deleting an edge also deletes edges attached to that edge.
	 */
	Graph.prototype._cascadeDeleteRels = function ( dead ) {
		var self = this;
		var changed = true;
		while ( changed ) {
			changed = false;
			Object.keys( this.doc.relationships ).forEach( function ( rid ) {
				var rel = self.doc.relationships[ rid ];
				if ( dead[ rel.from ] || dead[ rel.to ] ) {
					delete self.doc.relationships[ rid ];
					self._closeCard( 'rel:' + rid );
					dead[ rid ] = true;
					changed = true;
				}
			} );
		}
	};

	Graph.prototype._deleteThing = function ( id ) {
		this._pushUndo();
		delete this.doc.things[ id ];
		this._closeCard( 'thing:' + id );
		var dead = {};
		dead[ id ] = true;
		this._cascadeDeleteRels( dead );
		if ( this.selection && !this._selectionExists() ) {
			this.selection = null;
		}
		this._markDirty();
	};

	Graph.prototype._deleteRel = function ( id ) {
		this._pushUndo();
		delete this.doc.relationships[ id ];
		this._closeCard( 'rel:' + id );
		var dead = {};
		dead[ id ] = true;
		this._cascadeDeleteRels( dead );
		if ( this.selection && !this._selectionExists() ) {
			this.selection = null;
		}
		this._markDirty();
	};

	Graph.prototype._selectionExists = function () {
		if ( !this.selection ) {
			return false;
		}
		return this.selection.kind === 'thing' ?
			!!this.doc.things[ this.selection.id ] :
			!!this.doc.relationships[ this.selection.id ];
	};

	Graph.prototype._addTag = function ( name ) {
		var id = this._newId();
		var used = Object.keys( this.doc.tags ).length;
		this.doc.tags[ id ] = {
			name: name,
			color: PALETTE[ 1 + ( used % ( PALETTE.length - 1 ) ) ]
		};
		return id;
	};

	// ---- selection & view -------------------------------------------------

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

	Graph.prototype.getDocJson = function () {
		return JSON.stringify( this.doc, null, '\t' );
	};

	Graph.prototype.setDoc = function ( doc ) {
		this.doc = normalizeDoc( doc );
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.selection = null;
		this._closeAllCards();
		this._openPinnedCards();
		this.markSaved();
		this._scheduleRender();
	};

	Graph.prototype.setEditable = function ( editable ) {
		this.editable = !!editable;
		this._cancelTagChooser();
		this._closeAllCards();
		this._openPinnedCards();
		this.selection = null;
		this._updateHint();
		this._scheduleRender();
	};

	Graph.prototype.destroy = function () {
		this._resizeObserver.disconnect();
		this.container.textContent = '';
		this.container.classList.remove( 'inf-graph' );
	};

	// ---- events -----------------------------------------------------------

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
				start.undoPushed = false;
			} else if ( thing && this.editable ) {
				start.mode = 'thing';
				start.id = thing;
				var t = this.doc.things[ thing ];
				start.grabOffset = { x: t.x - wpt.x, y: t.y - wpt.y };
				start.undoPushed = false;
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
			if ( this.editable && ( overThing || overRel ) ) {
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
			// hover feedback
			var thing = this._thingAt( wpt );
			this.hover = thing ? { kind: 'thing', id: thing } : null;
			if ( !thing ) {
				var rel = this._relAt( wpt );
				if ( rel ) {
					this.hover = { kind: 'rel', id: rel };
				}
			}
			var linked = !this.editable && thing && this.doc.things[ thing ].link;
			this.canvas.style.cursor = linked ? 'pointer' : ( thing ? 'grab' : '' );
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
			if ( !d.undoPushed ) {
				this._pushUndo();
				d.undoPushed = true;
			}
			var t = this.doc.things[ d.id ];
			t.x = wpt.x + d.grabOffset.x;
			t.y = wpt.y + d.grabOffset.y;
			this._markDirty();
		} else if ( d.mode === 'handle' && d.moved ) {
			if ( !d.undoPushed ) {
				this._pushUndo();
				d.undoPushed = true;
			}
			var rel = this.doc.relationships[ d.id ];
			rel.hx = wpt.x;
			rel.hy = wpt.y;
			rel.hset = true;
			this._markDirty();
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
			this._addThing( wpt );
		} else if ( d.mode === 'connect' ) {
			var target = this._thingAt( wpt ) || this._relAt( wpt );
			if ( target === d.id ) {
				// right-click without dragging: open the card
				this._select( this.doc.things[ d.id ] ? 'thing' : 'rel', d.id );
			} else {
				if ( !target ) {
					target = this._addThing( wpt );
				}
				var relId = this._addRelationship( d.id, target );
				this._select( 'rel', relId );
				this._openTagChooser( relId, pos );
			}
		} else if ( d.mode === 'thing' && !d.moved ) {
			this._select( 'thing', d.id );
		} else if ( d.mode === 'clickThing' && !d.moved ) {
			var t = this.doc.things[ d.id ];
			if ( !this.editable && t.link ) {
				this.navigate( t.link );
			} else {
				this._select( 'thing', d.id );
			}
		} else if ( d.mode === 'clickRel' && !d.moved ) {
			this._select( 'rel', d.id );
		} else if ( d.deselectOnClick && !d.moved ) {
			this._select( null );
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
		var mod = e.ctrlKey || e.metaKey;
		if ( mod && !e.shiftKey && e.key.toLowerCase() === 'z' ) {
			e.preventDefault();
			this.undo();
		} else if ( ( mod && e.shiftKey && e.key.toLowerCase() === 'z' ) ||
			( mod && e.key.toLowerCase() === 'y' ) ) {
			e.preventDefault();
			this.redo();
		} else if ( ( e.key === 'Delete' || e.key === 'Backspace' ) && this.selection ) {
			e.preventDefault();
			if ( this.selection.kind === 'thing' ) {
				this._deleteThing( this.selection.id );
			} else {
				this._deleteRel( this.selection.id );
			}
		} else if ( e.key === 'Escape' ) {
			this._cancelTagChooser();
			this._select( null );
		}
	};

	// ---- tag chooser ------------------------------------------------------

	Graph.prototype._openTagChooser = function ( relId, screenPos ) {
		this._cancelTagChooser();
		var self = this;
		var box = el( 'div', 'inf-card inf-tag-chooser', this.overlay );
		box.style.left = Math.min( screenPos.x, this.container.clientWidth - 180 ) + 'px';
		box.style.top = Math.min( screenPos.y, this.container.clientHeight - 160 ) + 'px';
		var title = el( 'div', 'inf-card-title', box );
		title.textContent = 'Relationship tag';

		Object.keys( this.doc.tags ).forEach( function ( tagId ) {
			var tag = self.doc.tags[ tagId ];
			var row = el( 'button', 'inf-tag-option', box );
			row.type = 'button';
			var dot = el( 'span', 'inf-tag-dot', row );
			dot.style.background = tag.color;
			row.appendChild( document.createTextNode( tag.name || '(unnamed)' ) );
			row.addEventListener( 'click', function () {
				self._pushUndo();
				self.doc.relationships[ relId ].tag = tagId;
				self._finishTagChooser( relId );
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
			if ( !name ) {
				return;
			}
			self._pushUndo();
			self.doc.relationships[ relId ].tag = self._addTag( name );
			self._finishTagChooser( relId );
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
			self._finishTagChooser( relId );
		} );

		this.tagChooser = { el: box, relId: relId };
		input.focus();
	};

	Graph.prototype._finishTagChooser = function ( relId ) {
		if ( this.tagChooser ) {
			this.tagChooser.el.remove();
			this.tagChooser = null;
		}
		// the chooser's buttons are gone; keep keyboard shortcuts working
		this.container.focus( { preventScroll: true } );
		this._markDirty();
		this._select( 'rel', relId );
	};

	Graph.prototype._cancelTagChooser = function () {
		if ( this.tagChooser ) {
			this.tagChooser.el.remove();
			this.tagChooser = null;
		}
	};

	// ---- inspector cards --------------------------------------------------

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
			function up( ev ) {
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
		if ( !this.editable ) {
			pin.disabled = true;
		}
		pin.addEventListener( 'click', function () {
			self._pushUndo();
			obj.pinned = !obj.pinned;
			pin.classList.toggle( 'inf-pinned', obj.pinned );
			self._markDirty();
		} );
		var close = el( 'button', 'inf-icon-btn', head );
		close.type = 'button';
		close.title = 'Close';
		close.textContent = '×';
		close.addEventListener( 'click', function () {
			self._closeCard( self._cardKeyFor( card.kind, card.id ) );
		} );
		return head;
	};

	Graph.prototype._colorRow = function ( parent, current, onPick ) {
		var row = el( 'div', 'inf-colors', parent );
		var self = this;
		PALETTE.forEach( function ( color ) {
			var swatch = el( 'button', 'inf-swatch' + ( color === current ? ' inf-swatch-active' : '' ), row );
			swatch.type = 'button';
			swatch.style.background = color;
			swatch.disabled = !self.editable;
			swatch.addEventListener( 'click', function () {
				onPick( color );
				Array.prototype.forEach.call( row.children, function ( c ) {
					c.classList.toggle( 'inf-swatch-active', c === swatch );
				} );
			} );
		} );
		return row;
	};

	Graph.prototype._buildThingCard = function ( card ) {
		var self = this;
		var thing = this.doc.things[ card.id ];
		if ( !thing ) {
			return;
		}
		this._cardHeader( card, 'Thing', thing );
		var body = el( 'div', 'inf-card-body', card.el );

		var name = el( 'input', 'inf-input', body );
		name.placeholder = 'name';
		name.value = thing.name;
		name.readOnly = !this.editable;
		name.addEventListener( 'focus', function () {
			card.nameBefore = thing.name;
		} );
		name.addEventListener( 'input', function () {
			thing.name = name.value;
			self._markDirty();
		} );
		name.addEventListener( 'blur', function () {
			if ( card.nameBefore !== thing.name ) {
				var current = thing.name;
				thing.name = card.nameBefore;
				self._pushUndo();
				thing.name = current;
			}
		} );
		name.addEventListener( 'keydown', function ( e ) {
			if ( e.key === 'Enter' ) {
				name.blur();
			}
			e.stopPropagation();
		} );
		card.fields.name = name;

		this._colorRow( body, thing.color, function ( color ) {
			self._pushUndo();
			thing.color = color;
			self._markDirty();
		} );

		var linkRow = el( 'div', 'inf-row', body );
		var link = el( 'input', 'inf-input', linkRow );
		link.placeholder = 'wiki page link…';
		link.value = thing.link;
		link.readOnly = !this.editable;
		link.addEventListener( 'change', function () {
			self._pushUndo();
			thing.link = link.value.trim();
			self._markDirty();
			updateGo();
		} );
		link.addEventListener( 'keydown', function ( e ) {
			e.stopPropagation();
		} );
		var go = el( 'a', 'inf-link-go', linkRow );
		go.textContent = '↗';
		go.title = 'Open linked page';
		function updateGo() {
			var href = thing.link ? self.resolveHref( thing.link ) : null;
			go.style.display = href ? '' : 'none';
			if ( href ) {
				go.href = href;
			}
		}
		updateGo();

		if ( this.editable ) {
			var del = el( 'button', 'inf-btn inf-btn-danger', body );
			del.type = 'button';
			del.textContent = 'Delete thing';
			del.addEventListener( 'click', function () {
				self._deleteThing( card.id );
			} );
		}
	};

	/** Human label for an endpoint: a thing's name, or a bracketed edge description. */
	Graph.prototype._endpointLabel = function ( id ) {
		var thing = this.doc.things[ id ];
		if ( thing ) {
			return thing.name || '?';
		}
		var rel = this.doc.relationships[ id ];
		if ( !rel ) {
			return '?';
		}
		var tag = rel.tag ? this.doc.tags[ rel.tag ] : null;
		return '[' + ( tag && tag.name ?
			tag.name :
			this._endpointLabel( rel.from ) + '→' + this._endpointLabel( rel.to ) ) + ']';
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

		// tag picker
		var tagRow = el( 'div', 'inf-row', body );
		var select = el( 'select', 'inf-input', tagRow );
		select.disabled = !this.editable;
		var none = el( 'option', null, select );
		none.value = '';
		none.textContent = '(no tag)';
		Object.keys( this.doc.tags ).forEach( function ( tagId ) {
			var opt = el( 'option', null, select );
			opt.value = tagId;
			opt.textContent = self.doc.tags[ tagId ].name || '(unnamed)';
		} );
		var createOpt = el( 'option', null, select );
		createOpt.value = '__new__';
		createOpt.textContent = '+ new tag…';
		select.value = rel.tag || '';
		select.addEventListener( 'change', function () {
			if ( select.value === '__new__' ) {
				var name = window.prompt( 'Tag name:' );
				if ( name && name.trim() ) {
					self._pushUndo();
					rel.tag = self._addTag( name.trim() );
					self._markDirty();
				}
				self._rebuildCard( card );
				return;
			}
			self._pushUndo();
			rel.tag = select.value || null;
			self._markDirty();
			self._rebuildCard( card );
		} );

		// tag rename + color, edits apply to every edge using the tag
		if ( rel.tag && this.doc.tags[ rel.tag ] ) {
			var tag = this.doc.tags[ rel.tag ];
			var rename = el( 'input', 'inf-input', body );
			rename.value = tag.name;
			rename.placeholder = 'tag name';
			rename.readOnly = !this.editable;
			rename.addEventListener( 'change', function () {
				self._pushUndo();
				tag.name = rename.value.trim();
				self._markDirty();
			} );
			rename.addEventListener( 'keydown', function ( e ) {
				e.stopPropagation();
			} );
			this._colorRow( body, tag.color, function ( color ) {
				self._pushUndo();
				tag.color = color;
				self._markDirty();
			} );
		}

		// evidence
		var evTitle = el( 'div', 'inf-section-title', body );
		evTitle.textContent = 'Evidence';
		var evList = el( 'div', 'inf-evidence', body );
		function renderEvidence() {
			evList.textContent = '';
			rel.evidence.forEach( function ( ev, i ) {
				var row = el( 'div', 'inf-evidence-item', evList );
				var source = el( 'input', 'inf-input', row );
				source.placeholder = 'source (url or page)';
				source.value = ev.source;
				source.readOnly = !self.editable;
				source.addEventListener( 'change', function () {
					self._pushUndo();
					ev.source = source.value;
					self._markDirty();
				} );
				source.addEventListener( 'keydown', function ( e ) {
					e.stopPropagation();
				} );
				var snippet = el( 'textarea', 'inf-input', row );
				snippet.placeholder = 'snippet';
				snippet.rows = 2;
				snippet.value = ev.snippet;
				snippet.readOnly = !self.editable;
				snippet.addEventListener( 'change', function () {
					self._pushUndo();
					ev.snippet = snippet.value;
					self._markDirty();
				} );
				snippet.addEventListener( 'keydown', function ( e ) {
					e.stopPropagation();
				} );
				if ( self.editable ) {
					var rm = el( 'button', 'inf-icon-btn', row );
					rm.type = 'button';
					rm.title = 'Remove evidence';
					rm.textContent = '×';
					rm.addEventListener( 'click', function () {
						self._pushUndo();
						rel.evidence.splice( i, 1 );
						self._markDirty();
						renderEvidence();
					} );
				}
			} );
			if ( !rel.evidence.length && !self.editable ) {
				var empty = el( 'div', 'inf-muted', evList );
				empty.textContent = 'No evidence recorded yet.';
			}
		}
		renderEvidence();
		if ( this.editable ) {
			var add = el( 'button', 'inf-btn', body );
			add.type = 'button';
			add.textContent = '+ add evidence';
			add.addEventListener( 'click', function () {
				self._pushUndo();
				rel.evidence.push( { source: '', snippet: '' } );
				self._markDirty();
				renderEvidence();
			} );

			var del = el( 'button', 'inf-btn inf-btn-danger', body );
			del.type = 'button';
			del.textContent = 'Delete relationship';
			del.addEventListener( 'click', function () {
				self._deleteRel( card.id );
			} );
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

	// ---- rendering --------------------------------------------------------

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
		ctx.fillStyle = '#1b1b1f';
		ctx.fillRect( 0, 0, this.canvas.width, this.canvas.height );

		// world transform
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
		this._positionCards();
	};

	// Port of the native app's draw_grid: adaptive power-of-two spacing.
	Graph.prototype._drawGrid = function ( ctx, view, zoom ) {
		var step = Math.pow( 2, Math.round( Math.log2( 60 / zoom ) ) );
		var self = this;
		[ [ step, 0.10 ], [ step * 4, 0.22 ] ].forEach( function ( pair ) {
			var s = pair[ 0 ];
			ctx.strokeStyle = 'rgba(128,128,128,' + pair[ 1 ] + ')';
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

	Graph.prototype._drawRelationships = function ( ctx, zoom ) {
		var self = this;
		Object.keys( this.doc.relationships ).forEach( function ( id ) {
			var rel = self.doc.relationships[ id ];
			var a = self._anchorOf( rel.from );
			var b = self._anchorOf( rel.to );
			var h = self._relHandle( rel );
			var tag = rel.tag ? self.doc.tags[ rel.tag ] : null;
			var color = tag ? tag.color : '#8d8d8d';
			var selected = self.selection && self.selection.kind === 'rel' && self.selection.id === id;
			var hovered = self.hover && self.hover.kind === 'rel' && self.hover.id === id;

			// trim endpoints to the anchor rims (node circle or label pill)
			var start = trimToRim( a, h.x, h.y );
			var end = trimToRim( b, h.x, h.y );

			ctx.strokeStyle = color;
			ctx.lineWidth = ( selected || hovered ? 2.5 : 1.5 );
			ctx.beginPath();
			ctx.moveTo( start.x, start.y );
			ctx.quadraticCurveTo( h.x, h.y, end.x, end.y );
			ctx.stroke();

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
			var label = tag ? tag.name : '';
			if ( rel.evidence.length ) {
				label += ( label ? ' ' : '' ) + '⧉' + rel.evidence.length;
			}
			if ( !label && self._isRelEndpoint( id ) ) {
				label = '◦';
			}
			if ( label ) {
				var mid = self._bezierPoint( rel, 0.5 );
				ctx.font = '11px sans-serif';
				var tw = ctx.measureText( label ).width;
				ctx.fillStyle = '#26262b';
				roundRect( ctx, mid.x - tw / 2 - 6, mid.y - 9, tw + 12, 18, 9 );
				ctx.fill();
				ctx.strokeStyle = color;
				ctx.lineWidth = 1;
				roundRect( ctx, mid.x - tw / 2 - 6, mid.y - 9, tw + 12, 18, 9 );
				ctx.stroke();
				ctx.fillStyle = '#e6e6e6';
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText( label, mid.x, mid.y );
			}

			// reshaping handle
			if ( selected && self.editable ) {
				ctx.save();
				ctx.translate( h.x, h.y );
				ctx.rotate( Math.PI / 4 );
				ctx.fillStyle = '#ffffff';
				ctx.fillRect( -5 / zoom, -5 / zoom, 10 / zoom, 10 / zoom );
				ctx.restore();
			}
		} );

		function trimToRim( anchor, cx, cy ) {
			var dx = cx - anchor.x;
			var dy = cy - anchor.y;
			var len = Math.hypot( dx, dy ) || 1;
			return {
				x: anchor.x + dx / len * anchor.r,
				y: anchor.y + dy / len * anchor.r
			};
		}
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

	Graph.prototype._drawThings = function ( ctx, zoom ) {
		var self = this;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		Object.keys( this.doc.things ).forEach( function ( id ) {
			var t = self.doc.things[ id ];
			var selected = self.selection && self.selection.kind === 'thing' && self.selection.id === id;
			var hovered = self.hover && self.hover.kind === 'thing' && self.hover.id === id;

			ctx.fillStyle = '#26262b';
			ctx.beginPath();
			ctx.arc( t.x, t.y, THING_RADIUS, 0, Math.PI * 2 );
			ctx.fill();
			ctx.strokeStyle = t.color;
			ctx.lineWidth = selected || hovered ? 3 : 1.5;
			ctx.stroke();
			if ( selected ) {
				ctx.strokeStyle = 'rgba(255,255,255,0.35)';
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.arc( t.x, t.y, THING_RADIUS + 4, 0, Math.PI * 2 );
				ctx.stroke();
			}

			// name, wrapped to the circle
			ctx.fillStyle = '#e6e6e6';
			ctx.font = '12px sans-serif';
			var lines = wrapText( ctx, t.name || '…', 54, 3 );
			var lh = 13;
			lines.forEach( function ( line, i ) {
				ctx.fillText( line, t.x, t.y + ( i - ( lines.length - 1 ) / 2 ) * lh );
			} );

			// link indicator
			if ( t.link ) {
				ctx.font = '11px sans-serif';
				ctx.fillStyle = '#9ab4ff';
				ctx.fillText( '↗', t.x + THING_RADIUS * 0.72, t.y - THING_RADIUS * 0.72 );
			}
		} );
	};

	Graph.prototype._drawGhost = function ( ctx, zoom ) {
		var d = this.drag;
		if ( !d || d.mode !== 'connect' || !d.ghostTo ) {
			return;
		}
		var from = this._anchorOf( d.id );
		ctx.strokeStyle = 'rgba(255,255,255,0.55)';
		ctx.lineWidth = 1.5;
		ctx.setLineDash( [ 6, 5 ] );
		ctx.beginPath();
		ctx.moveTo( from.x, from.y );
		ctx.lineTo( d.ghostTo.x, d.ghostTo.y );
		ctx.stroke();
		ctx.setLineDash( [] );
		var over = this._thingAt( d.ghostTo ) || this._relAt( d.ghostTo );
		if ( !over || over === d.id ) {
			ctx.strokeStyle = 'rgba(255,255,255,0.35)';
			ctx.beginPath();
			ctx.arc( d.ghostTo.x, d.ghostTo.y, THING_RADIUS, 0, Math.PI * 2 );
			ctx.stroke();
		}
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
		var rest = words.slice( 0 ).join( ' ' );
		lines.push( line );
		// ellipsize if we truncated
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

	function roundRect( ctx, x, y, w, h, r ) {
		ctx.beginPath();
		ctx.moveTo( x + r, y );
		ctx.arcTo( x + w, y, x + w, y + h, r );
		ctx.arcTo( x + w, y + h, x, y + h, r );
		ctx.arcTo( x, y + h, x, y, r );
		ctx.arcTo( x, y, x + w, y, r );
		ctx.closePath();
	}

	Graph.normalizeDoc = normalizeDoc;
	Graph.PALETTE = PALETTE;
	return Graph;
} ) );
