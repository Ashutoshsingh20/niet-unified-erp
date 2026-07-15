import { Module } from '@nestjs/common';
import { RegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';
import { RegistrationWindowsController } from './registration-windows.controller';
import { RegistrationWindowsService } from './registration-windows.service';

@Module({ controllers: [RegistrationController, RegistrationWindowsController],
  providers: [RegistrationService, RegistrationWindowsService] })
export class RegistrationModule {}
