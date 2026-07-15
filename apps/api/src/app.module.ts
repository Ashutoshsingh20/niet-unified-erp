import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './config/environment';
import { HealthModule } from './modules/health/health.module';
import { RequestContextModule } from './platform/request-context/request-context.module';
import { AuthModule } from './platform/auth/auth.module';
import { DatabaseModule } from './platform/database/database.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { EvidenceModule } from './platform/evidence/evidence.module';
import { AccessModule } from './modules/access/access.module';
import { ObjectStorageModule } from './platform/object-storage/object-storage.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SearchModule } from './modules/search/search.module';
import { SearchPlatformModule } from './platform/search/search-platform.module';
import { ObservabilityModule } from './platform/observability/observability.module';
import { StudentsModule } from './modules/students/students.module';
import { CurriculumModule } from './modules/curriculum/curriculum.module';
import { RegistrationModule } from './modules/registration/registration.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { FinanceModule } from './modules/finance/finance.module';
import { MigrationModule } from './modules/migration/migration.module';
import { AdmissionsModule } from './modules/admissions/admissions.module';
import { TimetableModule } from './modules/timetable/timetable.module';
import { StudentCoreModule } from './modules/student-core/student-core.module';
import { ProgrammesModule } from './modules/programmes/programmes.module';
import { HoldsModule } from './modules/holds/holds.module';
import { StudentWithdrawalsModule } from './modules/student-withdrawals/student-withdrawals.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnvironment }),
    RequestContextModule,
    AuthModule,
    DatabaseModule,
    EvidenceModule,
    ObjectStorageModule,
    SearchPlatformModule,
    ObservabilityModule,
    HealthModule,
    WorkflowModule,
    AccessModule,
    DocumentsModule,
    NotificationsModule,
    SearchModule,
    StudentsModule,
    CurriculumModule,
    RegistrationModule,
    AttendanceModule,
    FinanceModule,
    MigrationModule,
    AdmissionsModule,
    TimetableModule,
    StudentCoreModule,
    ProgrammesModule,
    HoldsModule,
    StudentWithdrawalsModule,
  ],
})
export class AppModule {}
