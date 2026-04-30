import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CancelEventDto {
  @ApiProperty({ example: 'плохая погода' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}
