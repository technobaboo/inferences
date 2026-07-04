<?php

namespace MediaWiki\Extension\Inferences;

use MediaWiki\Hook\ParserFirstCallInitHook;
use MediaWiki\Html\Html;
use MediaWiki\Parser\Parser;

class Hooks implements ParserFirstCallInitHook {

	public function onParserFirstCallInit( $parser ) {
		$parser->setHook( 'inferences-diagram', [ self::class, 'renderEmbed' ] );
		$parser->setFunctionHook( 'inference', [ self::class, 'renderInference' ] );
		$parser->setFunctionHook( 'inferencetype', [ self::class, 'renderInferenceType' ] );
	}

	/**
	 * Split "key=value" parser function arguments.
	 * @param string[] $args
	 * @return array<string,string>
	 */
	private static function extractParams( array $args ): array {
		$params = [];
		foreach ( $args as $arg ) {
			$parts = explode( '=', $arg, 2 );
			if ( count( $parts ) === 2 ) {
				$params[ trim( $parts[ 0 ] ) ] = trim( $parts[ 1 ] );
			}
		}
		return $params;
	}

	/**
	 * {{#inference: id=1 |to=Compositor |tag=talks to |inferred=yes
	 *   |evidence1=https://… |snippet1=…}}
	 *
	 * A relationship from the page this call sits on (or from one of the
	 * page's own inferences, via from=#id) to another page or inference
	 * (to=Title or to=Title#id). Renders an inline chip and accumulates
	 * all of the page's inferences into the 'inferences' page property so
	 * they are queryable via prop=pageprops.
	 *
	 * @param Parser $parser
	 * @param string ...$args
	 * @return array
	 */
	public static function renderInference( Parser $parser, ...$args ) {
		$params = self::extractParams( $args );
		$evidence = [];
		for ( $i = 1; isset( $params[ 'evidence' . $i ] ) || isset( $params[ 'snippet' . $i ] ); $i++ ) {
			$evidence[] = [
				'source' => $params[ 'evidence' . $i ] ?? '',
				'snippet' => $params[ 'snippet' . $i ] ?? '',
			];
		}
		$output = $parser->getOutput();
		$list = json_decode( $output->getPageProperty( 'inferences' ) ?? '[]', true ) ?: [];
		$entry = [
			'id' => $params['id'] ?? (string)( count( $list ) + 1 ),
			'from' => $params['from'] ?? '',
			'to' => $params['to'] ?? '',
			'tag' => $params['tag'] ?? '',
			'inferred' => ( $params['inferred'] ?? '' ) === 'yes',
			'evidence' => $evidence,
		];
		$list[] = $entry;
		$output->setPageProperty( 'inferences', json_encode( $list ) );

		// Inline chip. Link the target page ("Title" or "Title#id"); a
		// leading "#id" references an inference on this very page.
		$to = $entry['to'];
		$hashPos = strpos( $to, '#' );
		$targetPage = $hashPos === false ? $to : substr( $to, 0, $hashPos );
		$suffix = $hashPos === false ? '' : ' §' . substr( $to, $hashPos + 1 );
		$therefore = $entry['inferred'] ? '∴ ' : '';
		$tagPart = $entry['tag'] !== '' ? "''" . $entry['tag'] . "'' " : '';
		$targetPart = $targetPage === '' ?
			'§' . substr( $to, 1 ) :
			'[[:' . $targetPage . '|' . $targetPage . $suffix . ']]';
		$wikitext = '<span class="inf-inline">' . $therefore . '→ ' .
			$tagPart . $targetPart . '</span>';
		return [ $wikitext, 'noparse' => false ];
	}

	/**
	 * {{#inferencetype: color=#46a758}} — placed on a Category page to
	 * mark that category as a thing type and optionally fix its color.
	 * Exposed via the 'inferencetype' page property.
	 *
	 * @param Parser $parser
	 * @param string ...$args
	 * @return array
	 */
	public static function renderInferenceType( Parser $parser, ...$args ) {
		$params = self::extractParams( $args );
		$color = $params['color'] ?? '';
		if ( !preg_match( '/^#[0-9a-fA-F]{6}$/', $color ) ) {
			$color = '';
		}
		$parser->getOutput()->setPageProperty( 'inferencetype', $color );
		$dot = $color === '' ? '' :
			Html::element( 'span', [
				'class' => 'inf-type-dot',
				'style' => 'background:' . $color,
			] );
		return [
			Html::rawElement( 'span', [ 'class' => 'inf-inline' ],
				$dot . ' thing type' ),
			'isHTML' => true,
		];
	}

	/**
	 * <inferences-diagram page="Some diagram" height="480" /> embeds a
	 * read-only view in ordinary wiki pages.
	 *
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
