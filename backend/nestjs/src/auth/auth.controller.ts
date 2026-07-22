import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';

@Controller('dashboard/api')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Get('bootstrap')
  async bootstrapStatus() {
    const bootstrap = await this.auth.isBootstrap();
    return {
      bootstrap,
      message: bootstrap
        ? 'No users yet — the first login creates the only admin account.'
        : 'Admin account exists — sign in with your email and password.',
    };
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Req() req: Request,
    @Body() body: { email?: string; password?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const user = await this.auth.loginOrBootstrap(body.email || '', body.password || '');
      const token = this.auth.createSessionToken(user);
      const secure =
        process.env.COOKIE_SECURE === 'true' ||
        req.secure === true ||
        req.headers['x-forwarded-proto'] === 'https';
      res.cookie(this.auth.getCookieName(), token, {
        httpOnly: true,
        sameSite: 'lax',
        secure,
        maxAge: 30 * 24 * 60 * 60 * 1000,
        path: '/',
      });
      return {
        ok: true,
        bootstrap: false,
        user: { id: user.id, email: user.email },
      };
    } catch (err) {
      throw new UnauthorizedException((err as Error).message);
    }
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const secure =
      process.env.COOKIE_SECURE === 'true' ||
      req.secure === true ||
      req.headers['x-forwarded-proto'] === 'https';
    res.clearCookie(this.auth.getCookieName(), { path: '/', secure, sameSite: 'lax' });
    return { ok: true };
  }

  @Get('me')
  me(@Req() req: Request) {
    const token = (req as any).cookies?.[this.auth.getCookieName()];
    const user = this.auth.verifySessionToken(token);
    if (!user) throw new UnauthorizedException('Not logged in');
    const apiKey = this.config.get<string>('apiKey') || '';
    return {
      user,
      apiKey,
      apiKeyConfigured: Boolean(apiKey),
    };
  }
}
