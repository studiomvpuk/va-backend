import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export const AUDIT_ACTIONS = [
  'credential.revealed',
  'credential.rotated',
  'credential.shared_without_rotation',
  'sensitive.disclosed',
  'agreement.signed',
  'va.invited',
  'va.revoked',
  'knowledge_gap.answered',
  'settings.changed',
  'byok_key.set',
] as const;

export class AuditQueryDto {
  @ApiPropertyOptional({ enum: AUDIT_ACTIONS })
  @IsOptional()
  @IsIn([...AUDIT_ACTIONS])
  action?: string;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class AuditEventDto {
  @ApiProperty() id!: string;
  @ApiProperty() action!: string;
  @ApiProperty() actorType!: string;
  @ApiProperty() actorId!: string;
  @ApiProperty() subjectType!: string;
  @ApiProperty() subjectId!: string;
  @ApiProperty() metadata!: unknown;
  @ApiProperty({ nullable: true }) ipAddress!: string | null;
  @ApiProperty() createdAt!: Date;
}
