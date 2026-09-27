import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { AbstractDocument } from '@app/common';

export type ReservationStatus =
  'pending' | 'confirmed' | 'failed' | 'needs_review';

@Schema({ _id: false })
export class OutboxEventDocument {
  @Prop({ required: true })
  eventId: string;

  @Prop({ required: true })
  pattern: string; // 'notify_email'

  @Prop({ type: Object, required: true })
  payload: Record<string, unknown>;

  @Prop({ type: Date, default: null })
  publishedAt: Date | null; // null = isn't published to RMQ yet
}

export const OutboxEventSchema =
  SchemaFactory.createForClass(OutboxEventDocument);

@Schema({ versionKey: false })
export class ReservationDocument extends AbstractDocument {
  @Prop() timestamp: Date;
  @Prop() startDate: Date;
  @Prop() endDate: Date;
  @Prop() userId: string;

  @Prop({ required: true, unique: true }) clientKey: string; // Idempotency key from frontend

  // Data that needed for reconciliation of charge
  @Prop({ required: true }) amount: number;
  @Prop({ required: true }) paymentMethodId: string;
  @Prop({ required: true }) email: string;

  // Payment state
  @Prop({ default: 'pending' }) status: ReservationStatus;
  @Prop({ type: String, default: null }) invoiceId: string | null;
  @Prop({ type: String, default: null }) failureReason: string | null;
  @Prop({ default: 0 }) reconcileAttempts: number;

  // MultipleInstance protection
  @Prop({ type: Date, default: null }) lockedUntil: Date | null;

  // outbox events for publishing. It is an array but actually only one event is processed now
  @Prop({ type: [OutboxEventSchema], default: [] })
  outbox: OutboxEventDocument[];
}

export const ReservationSchema =
  SchemaFactory.createForClass(ReservationDocument);

// for quick search of pending reservations
ReservationSchema.index({ status: 1, timestamp: 1 });

// for quick search of unpublished events
ReservationSchema.index({ 'outbox.publishedAt': 1 });
