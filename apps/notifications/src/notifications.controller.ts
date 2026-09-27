import { Controller, Logger } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { NotifyEmailDto } from './dto/notify-email.dto';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { NOTIFICATIONS_DLQ_EXCHANGE, NOTIFICATIONS_QUEUE } from '@app/common';
import type { Channel, ConsumeMessage } from 'amqplib';
import { once } from 'node:events';
import type { EventEmitter } from 'node:events';

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

function isObject(data: unknown): data is object {
  return typeof data === 'object' && data !== null;
}

@Controller()
export class NotificationsController {
  private readonly logger = new Logger(NotificationsController.name);

  constructor(private readonly notificationsService: NotificationsService) {}

  // Events arrive at-least-once: the outbox relay may republish after a crash,
  // and RabbitMQ redelivers unacked messages. Sending a duplicate email is
  // acceptable here, so there is no deduplication by `eventId`.
  // Copy this handler for anything with real side effects and add one.
  @EventPattern('notify_email')
  async notifyEmail(@Payload() data: unknown, @Ctx() context: RmqContext) {
    const channel = context.getChannelRef() as Channel;
    const message = context.getMessage() as ConsumeMessage;
    const attempt = getAttempt(message.properties.headers);

    // class-validator throws on null/primitives, which would leave the message unacked
    if (!isObject(data)) {
      await this.moveToDlq(
        channel,
        message,
        'payload must be an object',
        attempt,
      );
      return;
    }

    const dto = plainToInstance(NotifyEmailDto, data);
    const errors = await validate(dto);
    if (errors.length) {
      const reason = formatValidationErrors(errors);
      await this.moveToDlq(channel, message, reason, attempt);
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
        await this.moveToDlq(channel, message, reason, attempt);
        return;
      }

      this.logger.warn(
        { attempt, maxAttempts: MAX_ATTEMPTS, reason },
        'retry scheduled',
      );
      channel.nack(message, false, false);
    }
  }

  private async moveToDlq(
    channel: Channel,
    message: ConsumeMessage,
    reason: string,
    attempt: number,
  ) {
    const messageId = message.properties.messageId as string | undefined;
    this.logger.error({ attempt, reason, messageId }, 'moved to DLQ');

    try {
      const flushed = channel.publish(
        NOTIFICATIONS_DLQ_EXCHANGE,
        '',
        message.content,
        {
          ...message.properties,
          headers: {
            ...message.properties.headers,
            'x-failure-reason': reason.slice(0, MAX_FAILURE_REASON_LENGTH),
            'x-attempts': attempt,
          },
        },
      );

      if (!flushed) {
        await once(channel as unknown as EventEmitter, 'drain');
      }

      channel.ack(message);
    } catch (err: unknown) {
      this.logger.error({ err }, 'failed to move message to DLQ');
      this.nackToRetry(channel, message);
    }
  }

  // Goes through the retry queue and tries the DLQ again after the delay.
  // If the channel is already dead, the broker redelivers the message anyway.
  private nackToRetry(channel: Channel, message: ConsumeMessage) {
    try {
      channel.nack(message, false, false);
    } catch (err: unknown) {
      this.logger.error({ err }, 'failed to nack message');
    }
  }
}
