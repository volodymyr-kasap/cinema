import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  createReservationSchema,
  idParamSchema,
  paginationQuerySchema,
  reservationPageSchema,
  reservationSchema,
  type CreateReservation,
  type IdParam,
  type Page,
  type PaginationQuery,
  type Reservation,
} from '@cinema/contracts';

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

  // 200, not Nest's default 201 for POST: confirming creates no new resource,
  // it moves the one named in the path to its final state.
  @Post(':id/confirm')
  @HttpCode(200)
  @Validated(reservationSchema)
  confirmReservation(
    @SessionId() sessionId: string,
    @Param(zodPipe(idParamSchema)) params: IdParam,
  ): Promise<Reservation> {
    return this.reservations.confirm(sessionId, params.id);
  }
}
