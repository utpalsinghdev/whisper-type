import { Controller, Get, Next, Req, Res } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { AuthService } from '../auth/auth.service';

@Controller('dashboard')
export class DashboardPagesController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  home(@Req() req: Request, @Res() res: Response) {
    const token = (req as any).cookies?.[this.auth.getCookieName()];
    if (!this.auth.verifySessionToken(token)) {
      return res.redirect('/dashboard/login');
    }
    return this.sendHtml(res, 'dashboard.html');
  }

  @Get('login')
  login(@Req() req: Request, @Res() res: Response) {
    const token = (req as any).cookies?.[this.auth.getCookieName()];
    if (this.auth.verifySessionToken(token)) {
      return res.redirect('/dashboard');
    }
    return this.sendHtml(res, 'login.html');
  }

  private sendHtml(res: Response, file: string) {
    const filePath = path.join(__dirname, 'static', file);
    if (!fs.existsSync(filePath)) {
      return res.status(500).send('Dashboard assets missing');
    }
    res.type('html').send(fs.readFileSync(filePath, 'utf8'));
  }
}

/** Optional CSS/JS under /dashboard/static/* */
@Controller()
export class DashboardStaticController {
  @Get('dashboard/static/:file')
  staticFile(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction) {
    const file = path.basename((req.params as any).file || '');
    const filePath = path.join(__dirname, 'static', file);
    if (!file || !fs.existsSync(filePath)) return next();
    return res.sendFile(filePath);
  }
}
