import { Module } from '@nestjs/common';
import { CampaignTemplatesService } from './campaign-templates.service';
import { CampaignTemplatesController } from './campaign-templates.controller';

@Module({
  controllers: [CampaignTemplatesController],
  providers: [CampaignTemplatesService],
})
export class CampaignTemplatesModule {}

