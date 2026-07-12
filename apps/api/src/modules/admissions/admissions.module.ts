import { Module } from '@nestjs/common';
import { AdmissionsController } from './admissions.controller';
import { AdmissionsService } from './admissions.service';
import { StudentsModule } from '../students/students.module';
@Module({ imports: [StudentsModule], controllers: [AdmissionsController], providers: [AdmissionsService] })
export class AdmissionsModule {}
