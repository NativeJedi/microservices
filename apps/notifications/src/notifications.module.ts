import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { ConfigModule } from '@nestjs/config';
import { commonEnvValidationRules, LoggerModule } from '@app/common';
import { z } from 'zod';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: z.object({
        PORT: commonEnvValidationRules.PORT,
        SMTP_USER: z.string(),
        GOOGLE_OAUTH_CLIENT_ID: z.string(),
        GOOGLE_OAUTH_CLIENT_SECRET: z.string(),
        GOOGLE_OAUTH_REFRESH_TOKEN: z.string(),
      }),
    }),
    LoggerModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
