import { Module } from '@nestjs/common';
import { AdmissionsController } from './admissions.controller';
import { AdmissionsService } from './admissions.service';
import { StudentsModule } from '../students/students.module';
import { SeatMatricesController } from './seat-matrices.controller';
import { SeatMatricesService } from './seat-matrices.service';
import { MeritListsController } from './merit-lists.controller';
import { MeritListsService } from './merit-lists.service';
import { ConversionExceptionsController } from './conversion-exceptions.controller';
import { ConversionExceptionsService } from './conversion-exceptions.service';
@Module({ imports: [StudentsModule],
  controllers: [AdmissionsController, SeatMatricesController, MeritListsController,
    ConversionExceptionsController],
  providers: [AdmissionsService, SeatMatricesService, MeritListsService, ConversionExceptionsService] })
export class AdmissionsModule {}
