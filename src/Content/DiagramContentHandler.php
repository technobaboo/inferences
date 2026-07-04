<?php

namespace MediaWiki\Extension\Inferences\Content;

use MediaWiki\Content\Content;
use MediaWiki\Content\JsonContentHandler;
use MediaWiki\Content\Renderer\ContentParseParams;
use MediaWiki\Html\Html;
use MediaWiki\Parser\ParserOutput;
use MediaWiki\Title\Title;

class DiagramContentHandler extends JsonContentHandler {

	public function __construct( $modelId = DiagramContent::MODEL_ID ) {
		parent::__construct( $modelId );
	}

	protected function getContentClass() {
		return DiagramContent::class;
	}

	public function makeEmptyContent() {
		return new DiagramContent( DiagramContent::defaultDocument() );
	}

	/**
	 * Render a Diagram page as the interactive canvas. The document JSON
	 * rides along in a data attribute; ext.inferences.diagram hydrates it.
	 */
	protected function fillParserOutput(
		Content $content,
		ContentParseParams $cpoParams,
		ParserOutput &$output
	) {
		'@phan-var DiagramContent $content';
		if ( !$cpoParams->getGenerateHtml() ) {
			return;
		}

		if ( !$content->isValid() ) {
			$output->setRawText( Html::errorBox(
				wfMessage( 'inferences-invalid-doc' )->escaped()
			) );
			return;
		}

		// Register linked pages so "What links here" and red links work.
		foreach ( $content->getLinkedTitles() as $titleText ) {
			$title = Title::newFromText( $titleText );
			if ( $title ) {
				$output->addLink( $title );
			}
		}

		$output->addModules( [ 'ext.inferences.diagram' ] );
		$output->setRawText( Html::element( 'div', [
			'class' => 'ext-inferences-diagram',
			'data-inferences-doc' => $content->getText(),
		] ) );
	}
}
