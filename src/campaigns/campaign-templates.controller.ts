import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CampaignTemplatesService } from './campaign-templates.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';

@Controller('campaign-templates')
export class CampaignTemplatesController {
  constructor(private readonly svc: CampaignTemplatesService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@Body() dto: CreateTemplateDto) {
    return this.svc.create(dto);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.findOne(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTemplateDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Post(':id/preview')
  async preview(
    @Param('id') id: string,
    @Body('variables') variables: Record<string, any> = {},
    @Query('bodyOnly') bodyOnly?: string,
  ) {
    const tpl = await this.svc.findOne(id);
    const renderedBody = this.svc.render(tpl.body, variables || {});
    const payload: any = { channel: tpl.channel, body: renderedBody };
    if (tpl.channel === 'email') {
      payload.subject = this.svc.render(tpl.subject ?? '', variables || {});
    }
    if (bodyOnly === 'true') return payload.body;
    return payload;
  }
}

