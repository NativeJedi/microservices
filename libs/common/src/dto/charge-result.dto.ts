export type ChargeResult = {
  id: string; // Stripe PaymentIntent id
  status: 'succeeded' | 'processing' | 'requires_action' | string;
  amount: number; // cents
};

export type ChargeFailure = {
  kind: 'declined' | 'rejected' | 'unknown';
  message: string;
};
