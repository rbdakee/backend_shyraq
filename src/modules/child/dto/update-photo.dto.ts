import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UpdateChildPhotoDto {
  @ApiProperty({
    example: 'https://cdn.shyraq.kz/photos/aigerim.jpg',
    nullable: true,
    description: 'New photo URL, or null to clear.',
  })
  @IsOptional()
  @IsString()
  photo_url!: string | null;
}
