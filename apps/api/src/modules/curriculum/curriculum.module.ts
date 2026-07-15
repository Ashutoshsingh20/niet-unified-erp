import { Module } from '@nestjs/common';
import { CurriculumController } from './curriculum.controller';
import { CurriculumService } from './curriculum.service';
import { CurriculumRequirementsController } from './curriculum-requirements.controller';
import { CurriculumRequirementsService } from './curriculum-requirements.service';

@Module({ controllers: [CurriculumController, CurriculumRequirementsController],
  providers: [CurriculumService, CurriculumRequirementsService] })
export class CurriculumModule {}
