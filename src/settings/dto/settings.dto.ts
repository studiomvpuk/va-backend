import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsNumber, IsOptional, Max, Min } from 'class-validator';

const GAP_MODES = ['GUESS_AND_PROCEED', 'ASK_FIRST'] as const;

export class UpdateSettingsDto {
  @ApiPropertyOptional({
    minimum: 0,
    maximum: 10,
    description:
      'Jobs scoring below this are auto-skipped. Half-point steps; the slider ' +
      'in the UI uses the same increments.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(10)
  minFitScore?: number;

  @ApiPropertyOptional({
    enum: GAP_MODES,
    description:
      'What happens when the AI hits a genuine gap. GUESS_AND_PROCEED completes ' +
      'the application with a best-effort answer and flags it; ASK_FIRST pauses ' +
      'that application until you answer. Takes effect on the next gap, not ' +
      'retroactively.',
  })
  @IsOptional()
  @IsIn([...GAP_MODES])
  gapMode?: (typeof GAP_MODES)[number];

  @ApiPropertyOptional({
    description:
      'Use your own provider keys instead of platform billing. Switching this ' +
      'on without a stored key fails loudly rather than quietly billing us.',
  })
  @IsOptional()
  @IsBoolean()
  byokEnabled?: boolean;
}

export class SettingsDto {
  @ApiProperty() minFitScore!: number;
  @ApiProperty({ enum: GAP_MODES }) gapMode!: string;
  @ApiProperty() byokEnabled!: boolean;
  @ApiProperty() whatsappEnabled!: boolean;
}
