import { Module } from '@nestjs/common';
import { RegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';
import { RegistrationWindowsController } from './registration-windows.controller';
import { RegistrationWindowsService } from './registration-windows.service';
import { RegistrationEligibilityController } from './registration-eligibility.controller';
import { RegistrationEligibilityService } from './registration-eligibility.service';
import { RegistrationOverridesController } from './registration-overrides.controller';
import { RegistrationOverridesService } from './registration-overrides.service';
import { RegistrationCapacityController } from './registration-capacity.controller';
import { RegistrationCapacityService } from './registration-capacity.service';

@Module({ controllers: [RegistrationController, RegistrationWindowsController,
  RegistrationEligibilityController, RegistrationOverridesController, RegistrationCapacityController],
  providers: [RegistrationService, RegistrationWindowsService, RegistrationEligibilityService,
    RegistrationOverridesService, RegistrationCapacityService] })
export class RegistrationModule {}
