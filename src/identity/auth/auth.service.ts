import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenService } from './token.service';
import { PASSWORD_HASHER, type IPasswordHasher } from './password.interface';
import {
  ACCOUNT_REPOSITORY,
  type IAccountRepository,
} from '../accounts/client.repository';
import type { AccessTokenClaims, RequestMeta, TokenPair } from './auth.types';
import type { SubjectType } from './refresh-token.model';

export interface AuthResult extends TokenPair {
  user: { id: string; email: string; fullName: string; role: 'CLIENT' | 'VA' };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly tokens: TokenService,
    @Inject(PASSWORD_HASHER) private readonly passwords: IPasswordHasher,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: IAccountRepository,
  ) {}

  async registerClient(
    input: { email: string; fullName: string; password: string },
    meta: RequestMeta = {},
  ): Promise<AuthResult> {
    const email = AuthService.normaliseEmail(input.email);

    if (await this.accounts.findClientByEmail(email)) {
      // Registration is the one place account enumeration cannot be fully
      // avoided — the user has to be told the email is taken. Login and
      // password reset do not leak it (see `login`).
      throw new ConflictException('An account with that email already exists');
    }

    const client = await this.accounts.createClient({
      email,
      fullName: input.fullName.trim(),
      passwordHash: await this.passwords.hash(input.password),
    });

    return this.issueFor(client.id, client.email, client.fullName, 'CLIENT', client.id, meta);
  }

  async loginClient(
    input: { email: string; password: string },
    meta: RequestMeta = {},
  ): Promise<AuthResult> {
    const email = AuthService.normaliseEmail(input.email);
    const client = await this.accounts.findClientByEmail(email);

    // Hash even when no account exists, so a missing email and a wrong password
    // take the same time. Without this, response latency is an account
    // enumeration oracle.
    const hash = client?.passwordHash ?? DUMMY_HASH;
    const ok = await this.passwords.verify(hash, input.password);

    if (!client || !ok) throw new UnauthorizedException('Invalid email or password');

    if (this.passwords.needsRehash(client.passwordHash)) {
      await this.accounts.updateClientPasswordHash(
        client.id,
        await this.passwords.hash(input.password),
      );
    }

    return this.issueFor(client.id, client.email, client.fullName, 'CLIENT', client.id, meta);
  }

  async loginVa(
    input: { email: string; password: string },
    meta: RequestMeta = {},
  ): Promise<AuthResult> {
    const email = AuthService.normaliseEmail(input.email);
    const va = await this.accounts.findVaByEmail(email);

    const hash = va?.passwordHash ?? DUMMY_HASH;
    const ok = await this.passwords.verify(hash, input.password);

    // A revoked VA fails exactly like a wrong password: same message, same
    // status. Telling them the account exists but is revoked is information
    // they have no need for and an attacker does.
    if (!va || !va.passwordHash || !ok || va.revokedAt) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // The VA's tenant is the Client who invited them — this claim is what
    // confines them to exactly one Client's data.
    return this.issueFor(va.id, va.email, va.fullName, 'VA', va.clientId, meta);
  }

  async refresh(presentedToken: string, meta: RequestMeta = {}): Promise<AuthResult> {
    let resolved: AuthResult['user'] | null = null;

    const pair = await this.tokens.rotate(
      presentedToken,
      async (subjectType, subjectId) => {
        // Claims are rebuilt from current state on every refresh, so a VA
        // revoked since login loses access within one access-token lifetime
        // rather than at the end of the refresh window.
        if (subjectType === 'CLIENT') {
          const client = await this.accounts.findClientById(subjectId);
          if (!client) return null;
          resolved = {
            id: client.id,
            email: client.email,
            fullName: client.fullName,
            role: 'CLIENT',
          };
          return {
            sub: client.id,
            role: 'CLIENT',
            clientId: client.id,
            email: client.email,
          } satisfies AccessTokenClaims;
        }

        const va = await this.accounts.findVaById(subjectId);
        if (!va || va.revokedAt) return null;
        resolved = { id: va.id, email: va.email, fullName: va.fullName, role: 'VA' };
        return {
          sub: va.id,
          role: 'VA',
          clientId: va.clientId,
          email: va.email,
        } satisfies AccessTokenClaims;
      },
      meta,
    );

    if (!resolved) throw new UnauthorizedException('Invalid refresh token');
    return { ...pair, user: resolved };
  }

  async logout(presentedToken: string | undefined): Promise<void> {
    if (presentedToken) await this.tokens.revokeSession(presentedToken);
  }

  async logoutEverywhere(subjectType: SubjectType, subjectId: string): Promise<number> {
    return this.tokens.revokeAllSessions(subjectType, subjectId);
  }

  private async issueFor(
    id: string,
    email: string,
    fullName: string,
    role: 'CLIENT' | 'VA',
    clientId: string,
    meta: RequestMeta,
  ): Promise<AuthResult> {
    const pair = await this.tokens.issuePair(
      { sub: id, role, clientId, email },
      role,
      meta,
    );
    return { ...pair, user: { id, email, fullName, role } };
  }

  private static normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}

/**
 * A real argon2id hash of a value nobody knows, used to burn the same CPU time
 * on a missing account as on a wrong password.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZTEyMw$Hs2kZPaEDCoMPFpVKkcp0Z1Z4d7oOo3HqUqN1nY3vLg';
