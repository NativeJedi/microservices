import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { catchError, lastValueFrom, throwError } from 'rxjs';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateReservationDto } from './dto/update-reservation.dto';
import { ReservationsRepository } from './reservations.repository';
import { CreateChargeDto, PAYMENTS_SERVICE, UserDto } from '@app/common';
import { ClientProxy } from '@nestjs/microservices';

@Injectable()
export class ReservationsService {
  constructor(
    private readonly reservationsRepository: ReservationsRepository,
    @Inject(PAYMENTS_SERVICE) private readonly paymentsService: ClientProxy,
  ) {}

  async create(
    createReservationDto: CreateReservationDto,
    { email, _id: userId }: UserDto,
  ) {
    const { id } = await this.chargeOrFail({
      ...createReservationDto.charge,
      email,
    });

    return this.reservationsRepository.create({
      ...createReservationDto,
      timestamp: new Date(),
      userId,
      invoiceId: id,
    });
  }

  private async chargeOrFail(
    charge: CreateChargeDto & { email: UserDto['email'] },
  ) {
    return lastValueFrom(
      this.paymentsService.send('create_charge', charge).pipe(
        // The payments service reports declines as RPC errors, which would otherwise surface as 500.
        catchError((error) =>
          throwError(() => new BadRequestException(error.message ?? error)),
        ),
      ),
    );
  }

  async findAll() {
    return this.reservationsRepository.find({});
  }

  async findOne(id: string) {
    return this.reservationsRepository.findOne({ _id: id });
  }

  async update(id: string, updateReservationDto: UpdateReservationDto) {
    return this.reservationsRepository.findOneAndUpdate(
      { _id: id },
      { $set: updateReservationDto },
    );
  }

  async remove(id: string) {
    return this.reservationsRepository.findOneAndDelete({ _id: id });
  }
}
