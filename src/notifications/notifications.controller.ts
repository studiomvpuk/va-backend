import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../identity/auth/decorators/roles.decorator';
import { NotificationService } from './notification.service';
import {
  NotificationDto,
  NotificationQueryDto,
  UnreadCountDto,
} from './dto/notification.dto';

/**
 * Client-only, without exception.
 *
 * A VA has no business knowing what their Client has been told — a
 * knowledge-gap notification names the question the VA could not answer, and a
 * credential-reveal notification is the record of watching them. There is no
 * VA-facing notification feed and there should not be one.
 */
@ApiTags('notifications')
@Controller('notifications')
@Roles('CLIENT')
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @ApiOperation({ summary: 'This Client’s notifications, newest first' })
  list(@Query() query: NotificationQueryDto): Promise<NotificationDto[]> {
    return this.notifications.list({
      unreadOnly: query.unreadOnly ?? false,
      limit: query.limit ?? 30,
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Badge count for the header' })
  async unreadCount(): Promise<UnreadCountDto> {
    return { unread: await this.notifications.countUnread() };
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark one notification read' })
  async markRead(@Param('id') id: string): Promise<NotificationDto> {
    const notification = await this.notifications.markRead(id);
    // The repository is tenant-scoped, so another Client's id simply is not
    // found. 404 rather than 403, because saying "exists, not yours" would
    // confirm the id.
    if (!notification) throw new NotFoundException('Notification not found');
    return notification;
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Clear the badge' })
  async markAllRead(): Promise<UnreadCountDto> {
    await this.notifications.markAllRead();
    return { unread: 0 };
  }
}
