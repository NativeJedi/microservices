import amqp from 'amqplib';
import {
  NOTIFICATIONS_DLQ,
  NOTIFICATIONS_DLQ_EXCHANGE,
  NOTIFICATIONS_QUEUE,
  NOTIFICATIONS_RETRY_DELAY,
  NOTIFICATIONS_RETRY_EXCHANGE,
  NOTIFICATIONS_RETRY_QUEUE,
} from '@app/common';

export async function setupRabbit(
  url: string,
  retryDelayMs = NOTIFICATIONS_RETRY_DELAY,
) {
  const connection = await amqp.connect(url);
  const channel = await connection.createChannel();

  await channel.assertExchange(NOTIFICATIONS_RETRY_EXCHANGE, 'fanout', {
    durable: true,
  });
  await channel.assertQueue(NOTIFICATIONS_RETRY_QUEUE, {
    durable: true,
    arguments: {
      'x-message-ttl': retryDelayMs,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': NOTIFICATIONS_QUEUE,
    },
  });
  await channel.bindQueue(
    NOTIFICATIONS_RETRY_QUEUE,
    NOTIFICATIONS_RETRY_EXCHANGE,
    '',
  );

  await channel.assertExchange(NOTIFICATIONS_DLQ_EXCHANGE, 'fanout', {
    durable: true,
  });
  await channel.assertQueue(NOTIFICATIONS_DLQ, { durable: true });
  await channel.bindQueue(NOTIFICATIONS_DLQ, NOTIFICATIONS_DLQ_EXCHANGE, '');

  await channel.close();
  await connection.close();
}
