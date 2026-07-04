<?php

namespace MediaWiki\Extension\Inferences\Content;

use MediaWiki\Content\JsonContent;
use MediaWiki\Json\FormatJson;

/**
 * A diagram VIEW definition. The wiki itself is the graph: things are
 * ordinary wiki pages, relationships are {{#inference:…}} calls in those
 * pages' wikitext, and types are categories. This page only stores what
 * is specific to one view of that graph:
 *
 *   {
 *     "version": 2,
 *     "category": "Wayland",          // scope: auto-include this category
 *     "pages": [ "Some page" ],       // manually added members
 *     "view": { "x": 0, "y": 0, "zoom": 1 },
 *     "things": { "Page title": { "x": 0, "y": 0, "pinned": false } },
 *     "edges": { "Page title#1": { "hx": 0, "hy": 0, "hset": false,
 *                                   "pinned": false } }
 *   }
 */
class DiagramContent extends JsonContent {
	public const MODEL_ID = 'inferences-diagram';

	public function __construct( $text, $modelId = self::MODEL_ID ) {
		parent::__construct( $text, $modelId );
	}

	public static function defaultDocument(): string {
		return FormatJson::encode( [
			'version' => 2,
			'category' => '',
			'pages' => [],
			'view' => [ 'x' => 0, 'y' => 0, 'zoom' => 1 ],
			'things' => (object)[],
			'edges' => (object)[],
		], "\t" );
	}

	/**
	 * Valid JSON whose top level looks like a view document. Kept
	 * structural (types only) so hand-edited drafts aren't rejected.
	 */
	public function isValid() {
		if ( !parent::isValid() ) {
			return false;
		}
		$data = $this->getData()->getValue();
		if ( !is_object( $data ) ) {
			return false;
		}
		if ( isset( $data->pages ) && !is_array( $data->pages ) ) {
			return false;
		}
		if ( isset( $data->category ) && !is_string( $data->category ) ) {
			return false;
		}
		if ( isset( $data->allPages ) && !is_bool( $data->allPages ) ) {
			return false;
		}
		foreach ( [ 'things', 'edges', 'view' ] as $field ) {
			if ( isset( $data->$field ) && !is_object( $data->$field ) ) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Make the view findable: its scope category and member page names.
	 */
	public function getTextForSearchIndex() {
		$data = $this->getData()->getValue();
		if ( !is_object( $data ) ) {
			return parent::getTextForSearchIndex();
		}
		$words = [];
		if ( isset( $data->category ) && is_string( $data->category ) ) {
			$words[] = $data->category;
		}
		foreach ( [ 'pages' ] as $listField ) {
			if ( isset( $data->$listField ) && is_array( $data->$listField ) ) {
				foreach ( $data->$listField as $title ) {
					if ( is_string( $title ) ) {
						$words[] = $title;
					}
				}
			}
		}
		if ( isset( $data->things ) && is_object( $data->things ) ) {
			$words = array_merge( $words, array_keys( get_object_vars( $data->things ) ) );
		}
		return implode( "\n", array_filter( array_unique( $words ) ) );
	}

	/**
	 * Wiki pages this view references (manual members + laid-out pages).
	 * @return string[]
	 */
	public function getLinkedTitles(): array {
		$titles = [];
		$data = $this->getData()->getValue();
		if ( !is_object( $data ) ) {
			return $titles;
		}
		if ( isset( $data->pages ) && is_array( $data->pages ) ) {
			foreach ( $data->pages as $title ) {
				if ( is_string( $title ) && $title !== '' ) {
					$titles[] = $title;
				}
			}
		}
		if ( isset( $data->things ) && is_object( $data->things ) ) {
			foreach ( array_keys( get_object_vars( $data->things ) ) as $title ) {
				$titles[] = (string)$title;
			}
		}
		return array_unique( $titles );
	}
}
