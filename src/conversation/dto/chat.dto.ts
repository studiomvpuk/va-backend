import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const DRAFT_KINDS = ['CV', 'COVER_LETTER', 'SCREENING_ANSWER'] as const;

export class AssessPostingDto {
  @ApiProperty({ example: 'Descasio Ltd' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  companyName!: string;

  @ApiProperty({ example: 'Marketing Coordinator' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  roleTitle!: string;

  @ApiProperty({ description: 'The posting, pasted. Treated as untrusted input.' })
  @IsString()
  @MinLength(50)
  @MaxLength(50_000)
  jobDescription!: string;

  @ApiPropertyOptional({ description: 'Which approved site this came from.' })
  @IsOptional()
  @IsString()
  siteId?: string;
}

export class RequestDraftDto {
  @ApiProperty({ enum: DRAFT_KINDS })
  @IsIn([...DRAFT_KINDS])
  kind!: (typeof DRAFT_KINDS)[number];

  @ApiPropertyOptional({ description: 'Required for SCREENING_ANSWER.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  questionText?: string;
}

export class AskQuestionDto {
  @ApiProperty({ description: 'A screening question from the application form.' })
  @IsString()
  @MinLength(3)
  @MaxLength(4000)
  questionText!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  applicationId?: string;
}

export class ExtractFromImageDto {
  @ApiProperty({ description: 'base64, no data: prefix.' })
  @IsString()
  @MaxLength(8_000_000)
  image!: string;

  @ApiProperty({ enum: ['image/png', 'image/jpeg', 'image/webp'] })
  @IsIn(['image/png', 'image/jpeg', 'image/webp'])
  mediaType!: 'image/png' | 'image/jpeg' | 'image/webp';
}
