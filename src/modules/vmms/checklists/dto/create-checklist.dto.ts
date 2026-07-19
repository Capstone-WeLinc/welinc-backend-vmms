import { IsString, IsArray, IsNotEmpty, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateChecklistItemDto {
  @IsString()
  @IsNotEmpty()
  text: string;
}

export class CreateChecklistDto {
  @IsString()
  @IsNotEmpty()
  type: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateChecklistItemDto)
  items: CreateChecklistItemDto[];
}
