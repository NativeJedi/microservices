import { Controller } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { NotifyEmailDto } from './dto/notify-email.dto';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { NOTIFICATIONS_DLQ_EXCHANGE, NOTIFICATIONS_QUEUE } from '@app/common';
import type { Channel, ConsumeMessage } from 'amqplib';

const MAX_ATTEMPTS = 5;
const MAX_FAILURE_REASON_LENGTH = 500;

type DeathHeader = { queue: string; reason: string; count: number };

// Each retry cycle adds both a main-queue "rejected" and a retry-queue
// "expired" entry, so we count only rejections from the main queue.
function getAttempt(headers: Record<string, any> | undefined): number {
  const deaths = (headers?.['x-death'] ?? []) as DeathHeader[];
  const rejection = deaths.find(
    ({ queue, reason }) =>
      queue === NOTIFICATIONS_QUEUE && reason === 'rejected',
  );
  return (rejection?.count ?? 0) + 1;
}

function formatValidationErrors(errors: ValidationError[]): string {
  return errors
    .flatMap((error) => Object.values(error.constraints ?? {}))
    .join('; ');
}

@Controller()
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @EventPattern('notify_email')
  async notifyEmail(
    @Payload() data: NotifyEmailDto,
    @Ctx() context: RmqContext,
  ) {
    const channel = context.getChannelRef() as Channel;
    const message = context.getMessage() as ConsumeMessage;
    const attempt = getAttempt(message.properties.headers);

    const dto = plainToInstance(NotifyEmailDto, data);
    const errors = await validate(dto);
    if (errors.length) {
      const reason = formatValidationErrors(errors);
      this.moveToDlq(channel, message, reason, attempt);
      return;
    }

    await this.sendEmail(dto, channel, message, attempt);
  }

  private async sendEmail(
    dto: NotifyEmailDto,
    channel: Channel,
    message: ConsumeMessage,
    attempt: number,
  ) {
    try {
      await this.notificationsService.notifyEmail(dto);
      channel.ack(message);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (attempt >= MAX_ATTEMPTS) {
        this.moveToDlq(channel, message, reason, attempt);
        return;
      }

      console.warn(`[notifications] retry ${attempt}/${MAX_ATTEMPTS}`, reason);
      channel.nack(message, false, false);
    }
  }

  private moveToDlq(
    channel: Channel,
    message: ConsumeMessage,
    reason: string,
    attempt: number,
  ) {
    console.error(
      `[notifications] moving to DLQ after ${attempt} attempt(s)`,
      reason,
    );

    channel.publish(NOTIFICATIONS_DLQ_EXCHANGE, '', message.content, {
      ...message.properties,
      headers: {
        ...message.properties.headers,
        'x-failure-reason': reason.slice(0, MAX_FAILURE_REASON_LENGTH),
        'x-attempts': attempt,
      },
    });
    channel.ack(message);
  }
}
