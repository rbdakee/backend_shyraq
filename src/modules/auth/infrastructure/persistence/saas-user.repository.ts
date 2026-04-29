import { SaasUser } from '../../domain/entities/saas-user.entity';

export abstract class SaasUserRepository {
  abstract findById(id: string): Promise<SaasUser | null>;
  abstract findByEmail(email: string): Promise<SaasUser | null>;
  abstract updateLastLogin(id: string, at: Date): Promise<void>;
}
