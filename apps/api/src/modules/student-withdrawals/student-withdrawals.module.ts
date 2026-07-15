import { Module } from '@nestjs/common';
import { StudentWithdrawalsController } from './student-withdrawals.controller';
import { StudentWithdrawalsService } from './student-withdrawals.service';

@Module({ controllers: [StudentWithdrawalsController], providers: [StudentWithdrawalsService] })
export class StudentWithdrawalsModule {}
