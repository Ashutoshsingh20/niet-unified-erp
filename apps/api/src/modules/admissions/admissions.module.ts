import { Module } from '@nestjs/common';
import { AdmissionsController } from './admissions.controller';
import { AdmissionsService } from './admissions.service';
import { StudentsModule } from '../students/students.module';
import { SeatMatricesController } from './seat-matrices.controller';
import { SeatMatricesService } from './seat-matrices.service';
@Module({ imports: [StudentsModule], controllers: [AdmissionsController, SeatMatricesController],
  providers: [AdmissionsService, SeatMatricesService] })
export class AdmissionsModule {}
