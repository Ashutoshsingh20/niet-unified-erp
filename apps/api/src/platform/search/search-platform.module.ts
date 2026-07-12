import { Global, Module } from '@nestjs/common';
import { OpenSearchQueryAdapter } from './opensearch-query.adapter';

@Global()
@Module({ providers: [OpenSearchQueryAdapter], exports: [OpenSearchQueryAdapter] })
export class SearchPlatformModule {}

