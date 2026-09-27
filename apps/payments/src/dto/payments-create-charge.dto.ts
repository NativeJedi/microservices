import { CreateChargeDto } from '@app/common';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class PaymentsCreateChargeDto extends CreateChargeDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;
}
