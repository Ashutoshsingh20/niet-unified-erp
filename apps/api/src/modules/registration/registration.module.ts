import { Module } from '@nestjs/common';
import { RegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';
import { RegistrationWindowsController } from './registration-windows.controller';
import { RegistrationWindowsService } from './registration-windows.service';
import { RegistrationEligibilityController } from './registration-eligibility.controller';
import { RegistrationEligibilityService } from './registration-eligibility.service';
import { RegistrationOverridesController } from './registration-overrides.controller';
import { RegistrationOverridesService } from './registration-overrides.service';

@Module({ controllers: [RegistrationController, RegistrationWindowsController,
  RegistrationEligibilityController, RegistrationOverridesController],
  providers: [RegistrationService, RegistrationWindowsService, RegistrationEligibilityService,
    RegistrationOverridesService] })
export class RegistrationModule {}
