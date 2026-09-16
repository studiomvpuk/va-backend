import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ACCEPTED_AUDIO, type AudioMediaType } from '../voice-answer';

export class GapQueryDto {
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Transform(({ value }) => value !== false && value !== 'false')
  @IsBoolean()
  unresolvedOnly?: boolean;

  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class AnswerGapDto {
  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  answer!: string;
}

export class VoiceAnswerDto {
  @ApiProperty({ description: 'base64 audio, no data: prefix.' })
  @IsString()
  @MaxLength(12_000_000)
  audio!: string;

  @ApiProperty({ enum: ACCEPTED_AUDIO })
  @IsIn([...ACCEPTED_AUDIO])
  mediaType!: AudioMediaType;
}

export class KnowledgeGapDto {
  @ApiProperty() id!: string;
  @ApiProperty() applicationId!: string;
  @ApiProperty() questionText!: string;
  @ApiProperty({ nullable: true }) bestEffortAnswer!: string | null;
  @ApiProperty({ nullable: true }) clientAnswer!: string | null;
  @ApiProperty({ nullable: true }) resolvedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() companyName!: string;
  @ApiProperty() roleTitle!: string;
  @ApiProperty() applicationStatus!: string;
}
