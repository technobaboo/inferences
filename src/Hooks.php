<?php

namespace MediaWiki\Extension\Inferences;

use MediaWiki\Hook\ParserFirstCallInitHook;
use MediaWiki\Html\Html;
use MediaWiki\Parser\Parser;

class Hooks implements ParserFirstCallInitHook {

	/**
	 * Register <inferences-diagram page="Some diagram" height="480" />
	 * for embedding a read-only diagram view in ordinary wiki pages.
	 */
	public function onParserFirstCallInit( $parser ) {
		$parser->setHook( 'inferences-diagram', [ self::class, 'renderEmbed' ] );
	}

	/**
	 * @param string|null $input
	 * @param array $args
	 * @param Parser $parser
	 * @return string HTML
	 */
	public static function renderEmbed( $input, array $args, Parser $parser ) {
		$page = trim( $args['page'] ?? '' );
		if ( $page === '' ) {
			return Html::errorBox(
				wfMessage( 'inferences-embed-missing-page' )->parse()
			);
		}
		// Default to the Diagram namespace when none is given.
		if ( strpos( $page, ':' ) === false ) {
			$page = 'Diagram:' . $page;
		}
		$height = (int)( $args['height'] ?? 0 );
		if ( $height < 100 || $height > 4000 ) {
			$height = 480;
		}

		$parser->getOutput()->addModules( [ 'ext.inferences.diagram' ] );
		return Html::element( 'div', [
			'class' => 'ext-inferences-diagram ext-inferences-diagram-embed',
			'data-inferences-page' => $page,
			'data-inferences-height' => (string)$height,
		] );
	}
}
