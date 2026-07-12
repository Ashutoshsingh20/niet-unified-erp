import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Principal } from '../../platform/auth/auth.types';
import { CurrentPrincipal } from '../../platform/auth/principal.decorator';
import { RequirePermission } from '../../platform/auth/require-permission.decorator';
import { StudentCoreService, type StudentCoreOverview } from './student-core.service';
@ApiTags('student-core') @ApiBearerAuth() @Controller({ path: 'student-core', version: '1' })
export class StudentCoreController {
  constructor(private readonly studentCore: StudentCoreService) {}
  @Get('me') @RequirePermission('student.core.read')
  overview(@CurrentPrincipal() actor: Principal): Promise<StudentCoreOverview> {
    return this.studentCore.overview(actor);
  }
}
