import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { VaService } from './va.service';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  InvitationDto,
  InviteVaDto,
  SignatureVerificationDto,
  VaSummaryDto,
} from './dto/va.dto';

/** Client-side assistant management. */
@ApiTags('va')
@Controller('vas')
@Roles('CLIENT')
export class VaController {
  constructor(private readonly vas: VaService) {}

  @Get()
  @ApiOperation({ summary: 'Your assistants and their agreement status' })
  async list(): Promise<VaSummaryDto[]> {
    return this.vas.list();
  }

  @Post('invite')
  @ApiOperation({
    summary: 'Invite an assistant',
    description:
      'Returns a single-use token to put in the link you send them. Only its ' +
      'hash is stored, so this is the one time it exists.',
  })
  async invite(@Body() dto: InviteVaDto): Promise<InvitationDto> {
    return this.vas.invite(dto);
  }

  @Post(':id/resend-invite')
  @HttpCode(200)
  @ApiOperation({ summary: 'Issue a fresh link; the previous one stops working' })
  async resend(@Param('id') id: string): Promise<InvitationDto> {
    return this.vas.resendInvite(id);
  }

  @Get(':id/agreement')
  @ApiOperation({
    summary: 'Verify a signature',
    description:
      'Re-hashes the stored agreement text and compares it to what was recorded ' +
      'at signing, so this is proof rather than the database’s word for it.',
  })
  async verify(@Param('id') id: string): Promise<SignatureVerificationDto> {
    return this.vas.verifySignature(id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Revoke access immediately',
    description:
      'Ends their sessions now, not when their current token expires.',
  })
  async revoke(@Param('id') id: string): Promise<void> {
    await this.vas.revoke(id);
  }

  @Post(':id/restore')
  @HttpCode(204)
  @ApiOperation({ summary: 'Undo a revocation' })
  async restore(@Param('id') id: string): Promise<void> {
    await this.vas.restore(id);
  }
}
