import { Module } from '@nestjs/common';
import { AppConfigService } from '../core/config/app-config.service';
import { AiModule } from '../ai/ai.module';
import { HTTP_TRANSPORT, type HttpTransport } from '../ai/providers/transport';
import { ChannelDispatcher } from './channel-dispatcher';
import { NotificationService } from './notification.service';
import { NotificationsController } from './notifications.controller';
import { NOTIFICATION_REPOSITORY } from './notification.repository';
import { PrismaNotificationRepository } from './prisma-notification.repository';
import {
  NOTIFICATION_CHANNELS,
  type INotificationChannel,
} from './channels/notification-channel';
import { EMAIL_SENDER, type IEmailSender } from './channels/email-sender';
import { EmailChannel } from './channels/email.channel';
import { ConsoleEmailSender } from './channels/console-email-sender';
import { ResendEmailSender } from './channels/resend-email-sender';
import { WhatsAppChannel } from './channels/whatsapp.channel';

/**
 * Which sender is real depends on configuration, and the decision is made once
 * here rather than checked inside every send.
 *
 * Both halves must be present: a key with no verified from-address gets every
 * send rejected, which would look like an outage rather than a missing setting.
 */
const emailSenderProvider = {
  provide: EMAIL_SENDER,
  inject: [AppConfigService, HTTP_TRANSPORT],
  useFactory: (config: AppConfigService, transport: HttpTransport): IEmailSender =>
    config.get('RESEND_API_KEY') && config.get('EMAIL_FROM')
      ? new ResendEmailSender(transport, config)
      : new ConsoleEmailSender(),
};

/**
 * The channel list, assembled in one place.
 *
 * An array provider rather than a decorator scan: the set of channels is a
 * deployment decision, it is visible here in full, and a channel that is not in
 * this array cannot be reached by accident. WhatsApp (Phase 10) is one more
 * entry and no change anywhere else.
 */
const channelsProvider = {
  provide: NOTIFICATION_CHANNELS,
  inject: [EmailChannel, WhatsAppChannel],
  useFactory: (email: EmailChannel, whatsapp: WhatsAppChannel): INotificationChannel[] => [
    email,
    whatsapp,
  ],
};

@Module({
  imports: [AiModule],
  controllers: [NotificationsController],
  providers: [
    NotificationService,
    ChannelDispatcher,
    EmailChannel,
    WhatsAppChannel,
    emailSenderProvider,
    channelsProvider,
    { provide: NOTIFICATION_REPOSITORY, useClass: PrismaNotificationRepository },
  ],
  exports: [NotificationService],
})
export class NotificationsModule {}
