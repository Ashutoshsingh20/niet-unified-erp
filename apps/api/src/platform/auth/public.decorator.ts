import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_ROUTE = Symbol('isPublicRoute');
export const Public = (): ClassDecorator & MethodDecorator => SetMetadata(IS_PUBLIC_ROUTE, true);

