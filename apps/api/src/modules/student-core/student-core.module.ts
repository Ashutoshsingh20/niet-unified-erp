import { Module } from '@nestjs/common';
import { StudentCoreController } from './student-core.controller';
import { StudentCoreService } from './student-core.service';
@Module({ controllers: [StudentCoreController], providers: [StudentCoreService], exports: [StudentCoreService] })
export class StudentCoreModule {}
