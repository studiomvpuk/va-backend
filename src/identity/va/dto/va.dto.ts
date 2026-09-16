import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class InviteVaDto {
  @ApiProperty({ example: 'Joy Emoredo' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName!: string;

  @ApiProperty({ example: 'joy@example.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class AcceptInviteDto {
  @ApiProperty({ description: 'From the invitation link. Single use.' })
  @IsString()
  @MinLength(16)
  @MaxLength(256)
  token!: string;

  @ApiProperty({ minLength: 12 })
  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters' })
  @MaxLength(256)
  password!: string;
}

export class SignAgreementDto {
  @ApiProperty({
    description: 'Your full name, typed. This is the signature.',
    example: 'Joy Emoredo',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  signedName!: string;

  @ApiProperty({ description: 'Must be true. Unticked means unsigned.' })
  @IsBoolean()
  acknowledged!: boolean;
}

export class AgreementTextDto {
  @ApiProperty() version!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ description: 'Sign exactly this. It is hashed on signature.' })
  body!: string;
  @ApiProperty() effectiveFrom!: string;
}

export class VaSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true }) revokedAt!: Date | null;
  @ApiProperty() invitePending!: boolean;
  @ApiPropertyOptional({ nullable: true })
  agreement!: {
    signedAt: Date;
    signedName: string;
    documentVersion: string;
    documentHash: string;
  } | null;
}

export class InvitationDto {
  @ApiProperty({ type: VaSummaryDto }) va!: VaSummaryDto;
  @ApiProperty({
    description:
      'Shown ONCE. Only its hash is stored, so this cannot be recovered — ' +
      'resending issues a new one.',
  })
  inviteToken!: string;
  @ApiProperty() expiresAt!: Date;
}

export class SignatureVerificationDto {
  @ApiProperty({ description: 'The stored text still hashes to what was recorded.' })
  verified!: boolean;
  @ApiProperty({ nullable: true }) version!: string | null;
  @ApiProperty() isCurrentVersion!: boolean;
}
