import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';

@Injectable()
export class DashboardAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const token = req.cookies?.[this.auth.getCookieName()];
    const user = this.auth.verifySessionToken(token);
    if (!user) {
      throw new UnauthorizedException('Not logged in');
    }
    req.user = user;
    return true;
  }
}
