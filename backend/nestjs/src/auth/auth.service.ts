import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../db/prisma.service';

export interface AuthUser {
  id: number;
  email: string;
}

@Injectable()
export class AuthService {
  private readonly cookieName = 'wt_dash';

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  getCookieName() {
    return this.cookieName;
  }

  async userCount(): Promise<number> {
    return this.prisma.user.count();
  }

  async isBootstrap(): Promise<boolean> {
    return (await this.userCount()) === 0;
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
  }

  async loginOrBootstrap(email: string, password: string): Promise<AuthUser> {
    const normalized = email.trim().toLowerCase();
    if (!normalized || !password || password.length < 6) {
      throw new Error('Email and password (min 6 chars) are required');
    }

    if (await this.isBootstrap()) {
      const passwordHash = await bcrypt.hash(password, 12);
      const user = await this.prisma.user.create({
        data: { email: normalized, passwordHash },
      });
      return { id: user.id, email: user.email };
    }

    const user = await this.findByEmail(normalized);
    if (!user) {
      throw new Error('Invalid email or password');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      throw new Error('Invalid email or password');
    }
    return { id: user.id, email: user.email };
  }

  createSessionToken(user: AuthUser): string {
    const payload = Buffer.from(
      JSON.stringify({
        id: user.id,
        email: user.email,
        exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
      }),
    ).toString('base64url');
    const sig = this.sign(payload);
    return `${payload}.${sig}`;
  }

  verifySessionToken(token: string | undefined): AuthUser | null {
    if (!token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig || this.sign(payload) !== sig) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        id: number;
        email: string;
        exp: number;
      };
      if (!data?.id || !data?.email || !data?.exp || data.exp < Date.now()) return null;
      return { id: data.id, email: data.email };
    } catch {
      return null;
    }
  }

  private sign(payload: string): string {
    const secret = this.config.get<string>('sessionSecret') || 'wishpertype-dev-secret-change-me';
    return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  }
}
