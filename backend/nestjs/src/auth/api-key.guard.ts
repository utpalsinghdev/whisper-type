import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('apiKey') || '';
    if (!expected) {
      return true;
    }

    const req = context.switchToHttp().getRequest();
    const header =
      req.headers['x-api-key'] ||
      (typeof req.headers.authorization === 'string' &&
      req.headers.authorization.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : '');

    if (header !== expected) {
      throw new UnauthorizedException('invalid or missing api key');
    }
    return true;
  }
}
