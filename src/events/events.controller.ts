import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { EventEntity, EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';

@Controller('events')
export class EventsController {
  constructor(private readonly svc: EventsService) {}

  @Get()
  list(): EventEntity[] {
    return this.svc.list();
  }

  @Post()
  create(@Body() dto: CreateEventDto): EventEntity {
    return this.svc.create(dto);
  }

  @Get(':id')
  get(@Param('id') id: string): EventEntity {
    return this.svc.get(id);
  }
}
