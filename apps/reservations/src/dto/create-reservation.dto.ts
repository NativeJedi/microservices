import {
  IsDateString,
  IsDefined,
  IsNotEmpty,
  IsNotEmptyObject,
  IsString,
  ValidateNested,
} from 'class-validator';
import { CreateChargeDto } from '@app/common';
import { Type } from 'class-transformer';

export class CreateReservationDto {
  @IsDateString()
  startDate: Date;

  @IsDateString()
  endDate: Date;

  @IsDefined()
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => CreateChargeDto)
  charge: CreateChargeDto;
}
