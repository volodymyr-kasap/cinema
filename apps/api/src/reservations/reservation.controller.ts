import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  createReservationSchema,
  idParamSchema,
  paginationQuerySchema,
  PAYMENT_SCENARIO_HEADER,
  reservationPageSchema,
  reservationSchema,
  type CreateReservation,
  type IdParam,
  type Page,
  type PaginationQuery,
  type Reservation,
} from '@cinema/contracts';
import type { FastifyReply } from 'fastify';

import { SessionId } from '../http/session.decorator';
import { Validated } from '../http/validated.decorator';
import { zodPipe } from '../http/zod-validation.pipe';
import { ReservationService } from './reservation.service';

@Controller({ path: 'reservations', version: '1' })
export class ReservationController {
  constructor(private readonly reservations: ReservationService) {}

  @Post()
  @Validated(reservationSchema)
  createReservation(
    @SessionId() sessionId: string,
    @Body(zodPipe(createReservationSchema)) body: CreateReservation,
  ): Promise<Reservation> {
    return this.reservations.create(sessionId, body);
  }

  @Get()
  @Validated(reservationPageSchema)
  listReservations(
    @SessionId() sessionId: string,
    @Query(zodPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Page<Reservation>> {
    return this.reservations.list(sessionId, query);
  }

  @Get(':id')
  @Validated(reservationSchema)
  getReservation(
    @SessionId() sessionId: string,
    @Param(zodPipe(idParamSchema)) params: IdParam,
  ): Promise<Reservation> {
    return this.reservations.get(sessionId, params.id);
  }

  @Delete(':id')
  @HttpCode(204)
  cancelReservation(
    @SessionId() sessionId: string,
    @Param(zodPipe(idParamSchema)) params: IdParam,
  ): Promise<void> {
    return this.reservations.cancel(sessionId, params.id);
  }

  // 200 keeps its phase 2 meaning: the booking is final. 202 means the payment
  // has been accepted for processing and the reservation is not confirmed yet.
  // Answering 200 for both would be the API claiming a sale the provider has
  // not agreed to.
  @Post(':id/confirm')
  @HttpCode(200)
  @Validated(reservationSchema)
  async confirmReservation(
    @SessionId() sessionId: string,
    @Param(zodPipe(idParamSchema)) params: IdParam,
    @Headers(PAYMENT_SCENARIO_HEADER) scenario: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Reservation> {
    const outcome = await this.reservations.confirm(sessionId, params.id, scenario);
    if (outcome.paying) reply.status(202);
    return outcome.reservation;
  }
}
