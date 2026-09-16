import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateSiteDto {
  @ApiProperty({ example: 'Indeed UK' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'https://uk.indeed.com' })
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  url!: string;

  @ApiProperty({
    example: 'olont.jobs@gmail.com',
    description: 'The account the VA signs in as. Not a secret.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  username!: string;
}

export class UpdateSiteDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_protocol: true }) url?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(320) username?: string;
}

export class SetPasswordDto {
  @ApiProperty({ description: 'Stored encrypted. Never returned by any route.' })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  password!: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Marks this as a rotation. Replacing an existing password counts as one ' +
      'regardless — the old value has stopped being current either way.',
  })
  @IsOptional()
  @IsBoolean()
  rotate?: boolean;
}

export class AcknowledgeSharingDto {
  @ApiProperty({ description: 'The assistant who will see the current password.' })
  @IsString()
  vaId!: string;
}

export class SiteDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() url!: string;
  @ApiProperty() username!: string;
  @ApiProperty({ enum: ['NOT_CONNECTED', 'CONNECTED'] }) status!: string;
  @ApiProperty() hasPassword!: boolean;
  @ApiProperty({ nullable: true }) rotatedAt!: Date | null;
  @ApiProperty() createdAt!: Date;

  // Conspicuously absent: the password, and anything derived from it.
}

export class RevealedCredentialDto {
  @ApiProperty() revealId!: string;
  @ApiProperty() siteName!: string;
  @ApiProperty() username!: string;
  @ApiProperty({ description: 'Plaintext. This read has been logged.' })
  password!: string;
  @ApiProperty({ description: 'When the UI should hide it again.' })
  expiresAt!: Date;
}

export class RevealStatusDto {
  @ApiProperty({
    description: 'True when the owner rotated the password while this was on screen.',
  })
  superseded!: boolean;
}
