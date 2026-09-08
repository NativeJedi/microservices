import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserDocument } from '../users/entities/user.entity';

const getCurrentUserByContext = (context: ExecutionContext): UserDocument => {
  const request = context.switchToHttp().getRequest();

  return request.user;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    getCurrentUserByContext(context),
);
