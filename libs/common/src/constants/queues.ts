export const NOTIFICATIONS_QUEUE = 'notifications';

export const NOTIFICATIONS_RETRY_EXCHANGE = 'notifications.retry';
export const NOTIFICATIONS_RETRY_QUEUE = 'notifications.retry';
export const NOTIFICATIONS_RETRY_DELAY = 30_000;

export const NOTIFICATIONS_DLQ_EXCHANGE = 'notifications.dlq';
export const NOTIFICATIONS_DLQ = 'notifications.dlq';

export const NOTIFICATIONS_QUEUE_OPTIONS = {
  durable: true,
  arguments: {
    'x-dead-letter-exchange': NOTIFICATIONS_RETRY_EXCHANGE,
  },
};
