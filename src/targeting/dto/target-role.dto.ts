import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class TargetRoleInput {
  @ApiProperty({ example: 'Junior Frontend Developer' })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  title!: string;

  @ApiPropertyOptional({
    example: 'Remote or Manchester. React. Willing to consider contract.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  criteria?: string;
}

export class ReplaceTargetRolesDto {
  @ApiProperty({ type: [TargetRoleInput] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => TargetRoleInput)
  roles!: TargetRoleInput[];
}

export class TargetRoleDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ nullable: true }) criteria!: string | null;
}
