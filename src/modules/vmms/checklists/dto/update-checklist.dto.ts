import { IsString, IsArray, ValidateNested, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateChecklistItemDto } from './create-checklist.dto';

export class UpdateChecklistDto {
  @IsString()
  @IsOptional()
  type?: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateChecklistItemDto)
  items?: CreateChecklistItemDto[];
}
