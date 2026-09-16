import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../identity/auth/decorators/roles.decorator';
import { KnowledgeGapService } from './knowledge-gap.service';
import {
  AnswerGapDto,
  GapQueryDto,
  KnowledgeGapDto,
  VoiceAnswerDto,
} from './dto/knowledge-gap.dto';
import { VoiceAnswerError } from './voice-answer';

/**
 * Client-only.
 *
 * The VA already knows which questions they could not answer — they asked them.
 * What they must not see is the Client's answer arriving here, because a
 * resolved gap contains exactly the kind of personal detail the whole
 * disclosure mechanism exists to release deliberately rather than in bulk.
 */
@ApiTags('knowledge-gaps')
@Controller('knowledge-gaps')
@Roles('CLIENT')
export class KnowledgeGapController {
  constructor(private readonly gaps: KnowledgeGapService) {}

  @Get()
  @ApiOperation({ summary: 'The knowledge-gap queue, oldest first' })
  list(@Query() query: GapQueryDto): Promise<KnowledgeGapDto[]> {
    return this.gaps.list({
      unresolvedOnly: query.unresolvedOnly ?? true,
      limit: query.limit ?? 50,
    });
  }

  @Post(':id/answer')
  @ApiOperation({
    summary: 'Confirm or correct an answer — banks it and resumes the application',
  })
  answer(@Param('id') id: string, @Body() body: AnswerGapDto): Promise<KnowledgeGapDto> {
    return this.gaps.answerGap(id, body.answer);
  }

  @Post(':id/answer/voice')
  @ApiOperation({
    summary: 'Answer by voice note',
    description:
      'Transcribed, then treated exactly as a typed answer. Returns the ' +
      'transcript so it can be shown back and corrected.',
  })
  async answerByVoice(
    @Param('id') id: string,
    @Body() body: VoiceAnswerDto,
  ): Promise<{ gap: KnowledgeGapDto; transcript: string }> {
    try {
      return await this.gaps.answerGapByVoice(id, {
        audio: Buffer.from(body.audio, 'base64'),
        mediaType: body.mediaType,
      });
    } catch (e) {
      // A recording that could not be used is the Client's problem to retry,
      // not a server fault — 422 with the reason, never a 500.
      if (e instanceof VoiceAnswerError) throw new UnprocessableEntityException(e.message);
      throw e;
    }
  }
}
