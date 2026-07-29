import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

/**
 * Named `MealCopyWeekDto`, NOT `CopyWeekDto`, because
 * `schedule/dto/copy-week.dto.ts` already exports a `CopyWeekDto`.
 * Nest-Swagger keys `components.schemas` by CLASS NAME, so two same-named
 * DTOs collapse into one schema in `/docs-json` and whichever module is
 * registered last silently wins. That is exactly what happened here: the
 * meal endpoint documented the schedule body (`fromMonday`), generated
 * clients sent `fromMonday`, the global `whitelist: true` ValidationPipe
 * stripped it, and the endpoint answered 422 for every caller.
 *
 * Field name deliberately matches the schedule DTO (`fromMonday`) — both
 * endpoints are driven by the same "copy this week onto the next" UI action.
 */
export class MealCopyWeekDto {
  @ApiProperty({
    example: '2026-04-27',
    description:
      'ISO date YYYY-MM-DD — Monday of the source week. Plans in that week are copied onto the following week.',
  })
  @IsDateString()
  fromMonday!: string;
}
