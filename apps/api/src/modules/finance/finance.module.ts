import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { FeeStructuresController } from './fee-structures.controller';
import { FeeStructuresService } from './fee-structures.service';

@Module({ controllers: [FinanceController, FeeStructuresController],
  providers: [FinanceService, FeeStructuresService] })
export class FinanceModule {}
