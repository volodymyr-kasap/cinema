import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  cinemaPageSchema,
  cinemaSchema,
  idParamSchema,
  moviePageSchema,
  movieSchema,
  paginationQuerySchema,
  type Cinema,
  type IdParam,
  type Movie,
  type Page,
  type PaginationQuery,
} from '@cinema/contracts';

import { Validated } from '../http/validated.decorator';
import { zodPipe } from '../http/zod-validation.pipe';
import { CatalogService } from './catalog.service';

@Controller({ version: '1' })
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('movies')
  @Validated(moviePageSchema)
  listMovies(@Query(zodPipe(paginationQuerySchema)) query: PaginationQuery): Promise<Page<Movie>> {
    return this.catalog.listMovies(query);
  }

  @Get('movies/:id')
  @Validated(movieSchema)
  getMovie(@Param(zodPipe(idParamSchema)) params: IdParam): Promise<Movie> {
    return this.catalog.getMovie(params.id);
  }

  @Get('cinemas')
  @Validated(cinemaPageSchema)
  listCinemas(
    @Query(zodPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Page<Cinema>> {
    return this.catalog.listCinemas(query);
  }

  @Get('cinemas/:id')
  @Validated(cinemaSchema)
  getCinema(@Param(zodPipe(idParamSchema)) params: IdParam): Promise<Cinema> {
    return this.catalog.getCinema(params.id);
  }
}
