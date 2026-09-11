import { IsNotEmpty, IsNumber, IsPositive, IsString } from 'class-validator';

export class CreateChargeDto {
  @IsString()
  @IsNotEmpty()
  paymentMethodId: string;

  @IsNumber()
  @IsPositive()
  amount: number;
}
