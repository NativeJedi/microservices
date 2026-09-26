import { NestFactory } from '@nestjs/core';
import { NotificationsModule } from './notifications.module';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Logger } from 'nestjs-pino';
import { NOTIFICATIONS_QUEUE, NOTIFICATIONS_QUEUE_OPTIONS } from '@app/common';
import { setupRabbit } from './rabbit-topology';

async function bootstrap() {
  const app = await NestFactory.create(NotificationsModule);
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);

  const rabbitUrl = configService.getOrThrow<string>('RABBITMQ_URI');

  await setupRabbit(rabbitUrl);

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [rabbitUrl],
      queue: NOTIFICATIONS_QUEUE,
      queueOptions: NOTIFICATIONS_QUEUE_OPTIONS,
      noAck: false,
      prefetchCount: 10,
    },
  });

  app.useLogger(app.get(Logger));

  await app.startAllMicroservices();
}
bootstrap();
