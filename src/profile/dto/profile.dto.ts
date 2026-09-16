import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const VISIBILITY = ['GENERAL', 'SENSITIVE'] as const;

export class CreateFieldDto {
  @ApiProperty({ example: 'home_address', description: 'Stable machine key.' })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message: 'key must be lower_snake_case and start with a letter',
  })
  key!: string;

  @ApiProperty({ example: 'Home address' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(4000)
  value!: string;

  @ApiProperty({ enum: VISIBILITY })
  @IsIn(VISIBILITY)
  visibility!: (typeof VISIBILITY)[number];
}

export class UpdateFieldDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  value?: string;

  @ApiPropertyOptional({ enum: VISIBILITY })
  @IsOptional()
  @IsIn(VISIBILITY)
  visibility?: (typeof VISIBILITY)[number];
}

export class UpdateNarrativeDto {
  @ApiProperty({ description: 'Free-form experience. Write naturally.' })
  @IsString()
  @MaxLength(20_000)
  body!: string;
}

export class ProfileFieldDto {
  @ApiProperty() id!: string;
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: VISIBILITY }) visibility!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Present only for GENERAL fields. A SENSITIVE field is always null here — ' +
      'use the reveal endpoint, which is audited.',
  })
  value!: string | null;

  @ApiProperty({ description: 'Whether a SENSITIVE field has a value stored.' })
  hasValue!: boolean;

  @ApiProperty() updatedAt!: Date;
}

export class ProfileDto {
  @ApiProperty() narrative!: string;
  @ApiProperty({ type: [ProfileFieldDto] }) fields!: ProfileFieldDto[];
}

export class RevealedValueDto {
  @ApiProperty({ description: 'The decrypted value. This read was logged.' })
  value!: string;
}

export class ImportCvDto {
  @ApiProperty({
    description:
      'The CV as plain text. Nothing is saved — everything comes back as ' +
      'suggestions you confirm.',
  })
  @IsString()
  @MinLength(50)
  @MaxLength(60_000)
  text!: string;
}

export class SuggestedFieldDto {
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() value!: string;
  @ApiProperty({ enum: VISIBILITY }) suggestedVisibility!: string;
}

export class CvSuggestionsDto {
  @ApiProperty() narrative!: string;
  @ApiProperty({ type: [SuggestedFieldDto] }) fields!: SuggestedFieldDto[];
  @ApiProperty({ description: 'Which prompt version produced these.' })
  promptVersion!: string;
  @ApiProperty({
    description: 'Anything proposed and then refused, with the reason.',
  })
  dropped!: { label: string; reason: string }[];
}

// Kept so the enum decorator import is used consistently across DTO files.
export { IsEnum };
