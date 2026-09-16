import { Module } from '@nestjs/common';
import { ACCOUNT_REPOSITORY } from './client.repository';
import { PrismaAccountRepository } from './prisma-account.repository';

@Module({
  providers: [{ provide: ACCOUNT_REPOSITORY, useClass: PrismaAccountRepository }],
  exports: [ACCOUNT_REPOSITORY],
})
export class AccountsModule {}
