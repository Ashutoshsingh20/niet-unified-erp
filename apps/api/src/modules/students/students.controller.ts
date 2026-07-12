import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { CreateStudentRecordDto } from './students.dto';
import { StudentsService, type StudentRecord } from './students.service';

@ApiTags('students')
@ApiBearerAuth()
@Controller({ path: 'students', version: '1' })
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Post()
  @RequirePermission('student.record.create', { stepUpLevel: 2 })
  @ApiCreatedResponse({ description: 'A provenance-preserving provisional student record was created.' })
  create(@Body() input: CreateStudentRecordDto,
    @CurrentPrincipal() actor: Principal): Promise<{ id: string; replayed: boolean }> {
    return this.students.create(input, actor);
  }

  @Get(':id')
  @RequirePermission('student.record.read')
  get(@Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() actor: Principal): Promise<StudentRecord> {
    return this.students.get(id, actor);
  }
}
