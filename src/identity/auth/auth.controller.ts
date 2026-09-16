import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { AppConfigService } from '../../core/config/app-config.service';
import { Public } from './decorators/public.decorator';
import { Roles } from './decorators/roles.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthResponseDto, LoginDto, RegisterDto } from './dto/auth.dto';
import {
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from './auth.cookies';
import type { AccessTokenClaims } from './auth.types';
import type { AuthResult } from './auth.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
  ) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Create a Client account' })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    return this.respond(res, await this.auth.registerClient(dto, meta(req)));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in as a Client' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    return this.respond(res, await this.auth.loginClient(dto, meta(req)));
  }

  @Public()
  @Post('va/login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in as a VA' })
  async vaLogin(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    return this.respond(res, await this.auth.loginVa(dto, meta(req)));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Exchange the refresh cookie for a new pair',
    description:
      'Rotating: the presented token is invalidated. Presenting a token twice ' +
      'revokes every token from that login.',
  })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const token = readRefreshCookie(req);
    if (!token) throw new UnauthorizedException('No refresh token');

    try {
      return this.respond(res, await this.auth.refresh(token, meta(req)));
    } catch (e) {
      // The token is dead either way — do not leave the browser resending it.
      clearRefreshCookie(res, this.config);
      throw e;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke this session' })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(readRefreshCookie(req));
    clearRefreshCookie(res, this.config);
  }

  @Roles('CLIENT', 'VA')
  @Post('logout-everywhere')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke every session for this account' })
  async logoutEverywhere(
    @CurrentUser() user: AccessTokenClaims,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logoutEverywhere(user.role, user.sub);
    clearRefreshCookie(res, this.config);
  }

  private respond(res: Response, result: AuthResult): AuthResponseDto {
    setRefreshCookie(res, this.config, result.refreshToken, result.refreshExpiresAt);
    // Note what is NOT returned: the refresh token. It exists only in the cookie.
    return { accessToken: result.accessToken, user: result.user };
  }
}

function meta(req: Request) {
  return {
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']?.slice(0, 500),
  };
}
