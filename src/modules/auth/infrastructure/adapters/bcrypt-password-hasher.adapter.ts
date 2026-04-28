import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import { AllConfigType } from '@/config/config.type';
import { PasswordHasherPort } from '../../password-hasher.port';

@Injectable()
export class BcryptPasswordHasherAdapter extends PasswordHasherPort {
  constructor(private readonly configService: ConfigService<AllConfigType>) {
    super();
  }

  async hash(plain: string): Promise<string> {
    const cost = this.configService.getOrThrow('auth.bcryptCost', {
      infer: true,
    });
    return bcrypt.hash(plain, cost);
  }

  async compare(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
