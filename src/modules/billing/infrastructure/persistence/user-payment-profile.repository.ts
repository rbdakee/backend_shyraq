import { UserPaymentProfile } from '../../domain/entities/user-payment-profile.entity';

/**
 * Owner-scoped persistence port for provider-neutral saved billing details.
 *
 * The table is global (no kindergarten RLS). Callers must always pass the
 * authenticated user's id; no list-all or cross-user lookup is exposed.
 */
export abstract class UserPaymentProfileRepository {
  abstract findByUserId(userId: string): Promise<UserPaymentProfile | null>;

  abstract save(profile: UserPaymentProfile): Promise<UserPaymentProfile>;

  abstract deleteByUserId(userId: string): Promise<boolean>;
}
