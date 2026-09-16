import { Global, Module } from '@nestjs/common';
import { AesGcmCipher } from './aes-gcm.cipher';
import { CREDENTIAL_CIPHER } from './cipher.interface';
import { KeyRotationService } from './rotation/key-rotation.service';

/**
 * Callers inject CREDENTIAL_CIPHER, never AesGcmCipher. Swapping the
 * implementation touches this file and nothing else.
 *
 * KeyRotationService is exported but has no route and no scheduled job. It runs
 * from `npm run rotate-keys`, deliberately: re-encrypting every stored secret
 * across every tenant is an operator action taken while watching it, not
 * something that should be reachable by an HTTP request.
 */
@Global()
@Module({
  providers: [{ provide: CREDENTIAL_CIPHER, useClass: AesGcmCipher }, KeyRotationService],
  exports: [CREDENTIAL_CIPHER, KeyRotationService],
})
export class CryptoModule {}
