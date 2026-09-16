import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { VaService } from './va.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AgreementExempt } from './decorators/agreement-exempt.decorator';
import type { AccessTokenClaims } from '../auth/auth.types';
import { AcceptInviteDto, AgreementTextDto, SignAgreementDto } from './dto/va.dto';

/**
 * The only three VA routes that run before the agreement is signed.
 *
 * Every one of them exists because signing is impossible otherwise: you cannot
 * sign without an account, you cannot sign text you have not been shown, and
 * you cannot sign without submitting a signature.
 */
@ApiTags('va')
@Controller('va')
export class VaOnboardingController {
  constructor(private readonly vas: VaService) {}

  @Public()
  @Post('accept-invite')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Accept an invitation and set a password',
    description: 'The link works once. Sign in afterwards to continue.',
  })
  async acceptInvite(@Body() dto: AcceptInviteDto) {
    const va = await this.vas.acceptInvite(dto);
    return { id: va.id, email: va.email, fullName: va.fullName };
  }

  @Roles('VA')
  @AgreementExempt()
  @Get('agreement')
  @ApiOperation({ summary: 'The agreement to read and sign' })
  agreement(): AgreementTextDto {
    return this.vas.currentAgreement();
  }

  @Roles('VA')
  @AgreementExempt()
  @Post('agreement/sign')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sign it',
    description:
      'Stores your name, the time, your IP, your browser, the agreement version ' +
      'and a hash of the exact text you were shown.',
  })
  async sign(
    @Body() dto: SignAgreementDto,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.vas.sign({
      vaId: user.sub,
      signedName: dto.signedName,
      acknowledged: dto.acknowledged,
      ipAddress: req.ip ?? 'unknown',
      userAgent: req.headers['user-agent'] ?? 'unknown',
    });
  }
}
