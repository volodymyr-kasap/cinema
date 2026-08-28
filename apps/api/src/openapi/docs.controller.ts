import { Controller, Get, Version, VERSION_NEUTRAL } from '@nestjs/common';

import { buildOpenApiDocument, type OpenApiDocument } from './document';

@Controller()
export class DocsController {
  private readonly document = buildOpenApiDocument();

  /** Unversioned: the document describes every version the API serves. */
  @Get('openapi.json')
  @Version(VERSION_NEUTRAL)
  openapi(): OpenApiDocument {
    return this.document;
  }
}
