import { Child } from '@/modules/child/domain/entities/child.entity';
import { User } from '@/modules/users/domain/entities/user.entity';
import { GetMyQrResponseDto } from './dto/get-my-qr-response.dto';
import { LinkedChildDto } from './dto/linked-child.dto';
import { ScanQrResponseDto, ScannedUserDto } from './dto/scan-qr-response.dto';
import { RevokeAllQrResponseDto } from './dto/revoke-all-qr-response.dto';

/**
 * Domain → response-DTO mappers for the identity-qr module. Kept pure (no
 * Nest/TypeORM imports) so the controllers remain thin and the same shapes
 * are reused in service-unit assertions.
 */
export const IdentityQrPresenter = {
  myQr(input: {
    token: string;
    issuedAt: Date;
    expiresAt: Date;
  }): GetMyQrResponseDto {
    return {
      token: input.token,
      issuedAt: input.issuedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
    };
  },

  scannedUser(user: User, role: string): ScannedUserDto {
    const s = user.toState();
    return {
      id: s.id,
      role,
      fullName: s.fullName,
      phone: s.phone ?? null,
    };
  },

  linkedChild(child: Child): LinkedChildDto {
    const s = child.toState();
    return {
      id: s.id,
      fullName: s.fullName,
      currentGroupId: s.currentGroupId,
      photoUrl: s.photoUrl,
    };
  },

  scan(input: {
    user: User;
    role: string;
    linkedChildren?: Child[];
    allowedActions: string[];
  }): ScanQrResponseDto {
    const out: ScanQrResponseDto = {
      user: IdentityQrPresenter.scannedUser(input.user, input.role),
      allowedActions: input.allowedActions,
    };
    if (input.linkedChildren !== undefined) {
      out.linkedChildren = input.linkedChildren.map((c) =>
        IdentityQrPresenter.linkedChild(c),
      );
    }
    return out;
  },

  revokeAll(revokedCount: number): RevokeAllQrResponseDto {
    return { revokedCount };
  },
};
