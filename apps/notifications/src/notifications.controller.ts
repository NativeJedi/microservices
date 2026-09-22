import { Controller } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { NotifyEmailDto } from './dto/notify-email.dto';
import { plainToInstance } from 'class-transformer';
import { validateOrReject } from 'class-validator';
import { NOTIFICATIONS_DLQ_EXCHANGE } from '@app/common';
import type { ConsumeMessage } from 'amqplib';

const MAX_ATTEMPTS = 5;

type DeathHeader = { count: number };

function getAttempt(headers: Record<string, any> | undefined): number {
  const deaths = headers?.['x-death'] as DeathHeader[] | undefined;
  return (deaths?.[0]?.count ?? 0) + 1;
}

@Controller()
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @EventPattern('notify_email')
  async notifyEmail(
    @Payload() data: NotifyEmailDto,
    @Ctx() context: RmqContext,
  ) {
    const channel = context.getChannelRef();
    const message = context.getMessage() as ConsumeMessage;
    const attempt = getAttempt(message);

    try {
      const dto = plainToInstance(NotifyEmailDto, data);
      await validateOrReject(dto);
      await this.notificationsService.notifyEmail(data);

      channel.ack(message);
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        console.error(
          `[notifications] giving up after ${attempt} attempts`,
          err,
        );

        channel.publish(NOTIFICATIONS_DLQ_EXCHANGE, '', message.content, {
          ...message.properties,
          headers: {
            ...message.properties.headers,
            'x-failure-reason': String((err as Error).message).slice(0, 500),
            'x-attempts': attempt,
          },
        });
        channel.ack(message);
        return;
      }

      console.warn(
        `[notifications] retry ${attempt}/${MAX_ATTEMPTS}`,
        (err as Error).message,
      );
      channel.nack(message, false, false);
    }
  }
}
