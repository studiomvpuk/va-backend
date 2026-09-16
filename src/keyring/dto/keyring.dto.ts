import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class SetProviderKeyDto {
  @ApiProperty({
    description:
      'Your own provider key. Stored encrypted and never returned by any route, ' +
      'to anyone, including you. If you lose it, replace it.',
  })
  @IsString()
  @MinLength(20)
  @MaxLength(512)
  key!: string;
}

export class ProviderKeyStatusDto {
  @ApiProperty({ enum: ['ANTHROPIC', 'OPENAI'] }) provider!: string;
  @ApiProperty() configured!: boolean;
  @ApiProperty({ nullable: true, description: 'Last four characters only.' })
  hint!: string | null;
  @ApiProperty({ nullable: true }) updatedAt!: Date | null;
}
