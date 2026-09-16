import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength, Matches } from 'class-validator';

/**
 * Password policy: length over composition.
 *
 * NIST SP 800-63B is explicit that composition rules (one upper, one digit, one
 * symbol) push people toward predictable substitutions and do not help. Minimum
 * length does help. The maximum exists only to bound hashing cost — argon2 on a
 * megabyte of input is a denial-of-service vector, not a security feature.
 */
export class RegisterDto {
  @ApiProperty({ example: 'Tolulope Olonibua' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName!: string;

  @ApiProperty({ example: 'you@email.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ minLength: 12, description: 'At least 12 characters.' })
  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters' })
  @MaxLength(256)
  @Matches(/^(?!\s+$).+/, { message: 'Password cannot be only whitespace' })
  password!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'you@email.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(256)
  password!: string;
}

export class AuthUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ enum: ['CLIENT', 'VA'] }) role!: 'CLIENT' | 'VA';
}

export class AuthResponseDto {
  @ApiProperty({ description: 'Short-lived. Hold in memory, send as a bearer token.' })
  accessToken!: string;

  @ApiProperty() user!: AuthUserDto;

  // The refresh token is NOT in this body. It is set as an httpOnly cookie
  // scoped to the refresh path, so JavaScript cannot read it and XSS cannot
  // exfiltrate a long-lived credential.
}
