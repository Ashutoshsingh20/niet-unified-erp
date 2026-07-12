import { Global, Module } from '@nestjs/common';
import { TransactionalEvidenceService } from './transactional-evidence.service';

@Global()
@Module({
  providers: [TransactionalEvidenceService],
  exports: [TransactionalEvidenceService],
})
export class EvidenceModule {}

