<?php

namespace MediaWiki\Extension\Inferences\Content;

use MediaWiki\Content\JsonContent;
use MediaWiki\Json\FormatJson;

/**
 * A diagram document: things (nodes, optionally linked to wiki pages),
 * relationships (tagged edges carrying evidence), and tags.
 *
 * Stored as JSON so MediaWiki gives us revisions, diffs, talk pages and
 * permissions on every diagram. The shape mirrors the native Rust app:
 *
 *   {
 *     "version": 1,
 *     "view": { "x": 0, "y": 0, "zoom": 1 },
 *     "tags": { "<id>": { "name": "causes", "color": "#e5484d" } },
 *     "things": { "<id>": { "name": "...", "color": "#...", "x": 0, "y": 0,
 *                            "pinned": false, "link": "Wiki page title" } },
 *     "relationships": { "<id>": { "from": "<thingId>", "to": "<thingId>",
 *                                   "tag": "<tagId>", "hx": 0, "hy": 0,
 *                                   "pinned": false,
 *                                   "evidence": [ { "source": "...", "snippet": "..." } ] } },
 *     "nextId": 1
 *   }
 */
class DiagramContent extends JsonContent {
	public const MODEL_ID = 'inferences-diagram';

	public function __construct( $text, $modelId = self::MODEL_ID ) {
		parent::__construct( $text, $modelId );
	}

	public static function defaultDocument(): string {
		return FormatJson::encode( [
			'version' => 1,
			'view' => [ 'x' => 0, 'y' => 0, 'zoom' => 1 ],
			'tags' => (object)[],
			'things' => (object)[],
			'relationships' => (object)[],
			'nextId' => 1,
		], "\t" );
	}

	/**
	 * Valid JSON whose top level looks like a diagram document. Kept
	 * structural (types only) so hand-edited drafts aren't rejected
	 * for minor issues the editor can repair on load.
	 */
	public function isValid() {
		if ( !parent::isValid() ) {
			return false;
		}
		$data = $this->getData()->getValue();
		if ( !is_object( $data ) ) {
			return false;
		}
		foreach ( [ 'things', 'relationships', 'tags', 'types' ] as $field ) {
			if ( isset( $data->$field ) && !is_object( $data->$field ) ) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Index the human-readable parts of the diagram — thing names, type
	 * names ("program"), tag names, linked titles, evidence — so wiki
	 * search finds diagrams by their content rather than JSON syntax.
	 */
	public function getTextForSearchIndex() {
		$data = $this->getData()->getValue();
		if ( !is_object( $data ) ) {
			return parent::getTextForSearchIndex();
		}
		$words = [];
		foreach ( [ 'things', 'types', 'tags' ] as $field ) {
			if ( isset( $data->$field ) && is_object( $data->$field ) ) {
				foreach ( get_object_vars( $data->$field ) as $entry ) {
					if ( is_object( $entry ) ) {
						foreach ( [ 'name', 'link' ] as $key ) {
							if ( isset( $entry->$key ) && is_string( $entry->$key ) ) {
								$words[] = $entry->$key;
							}
						}
					}
				}
			}
		}
		if ( isset( $data->relationships ) && is_object( $data->relationships ) ) {
			foreach ( get_object_vars( $data->relationships ) as $rel ) {
				if ( is_object( $rel ) && isset( $rel->evidence ) && is_array( $rel->evidence ) ) {
					foreach ( $rel->evidence as $evidence ) {
						foreach ( [ 'source', 'snippet' ] as $key ) {
							if ( is_object( $evidence ) && isset( $evidence->$key )
								&& is_string( $evidence->$key )
							) {
								$words[] = $evidence->$key;
							}
						}
					}
				}
			}
		}
		return implode( "\n", array_filter( array_unique( $words ) ) );
	}

	/**
	 * Wiki page titles referenced by things in this diagram.
	 * @return string[]
	 */
	public function getLinkedTitles(): array {
		$titles = [];
		$data = $this->getData()->getValue();
		if ( is_object( $data ) && isset( $data->things ) && is_object( $data->things ) ) {
			foreach ( get_object_vars( $data->things ) as $thing ) {
				if ( is_object( $thing ) && isset( $thing->link )
					&& is_string( $thing->link ) && $thing->link !== ''
				) {
					$titles[] = $thing->link;
				}
			}
		}
		return $titles;
	}
}
